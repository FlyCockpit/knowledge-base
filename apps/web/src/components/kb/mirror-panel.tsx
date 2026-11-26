import { Button } from "@knowledge-base/ui/components/button";
import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextareaField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, ExternalLink, Info, TriangleAlert } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { CheckRow } from "@/components/kb/check-row";
import { ControlError } from "@/components/kb/profile-panel";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";

type KbLike = { id: string; capabilities: readonly string[] };

type ProviderId = "github" | "gitlab" | "bitbucket";
type HostKeyView = {
  algorithm: string;
  key: string;
  fingerprint: string;
  check: "PUBLISHED" | "MISMATCH" | "UNPINNED";
};
type MirrorKeyView = {
  keyId: string;
  keyVersion: number;
  remoteVersion: number;
  state: "PENDING" | "ACTIVE";
  url: string;
  hostKeys: HostKeyView[];
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  provider: ProviderId | null;
  deployKeyUrl: string | null;
};
type AttemptView = {
  attemptId: string;
  action: "PUSH" | "ACTIVATE";
  state: string;
  resultCode: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type MirrorStatusLike = {
  kbId: string;
  state: "DISCONNECTED" | "PENDING" | "ACTIVE";
  remoteVersion: number;
  active: MirrorKeyView | null;
  pending: MirrorKeyView | null;
  pushEnabled: boolean;
  lastAttempt?: AttemptView | null;
  lastTest?: AttemptView | null;
  lastPush?: AttemptView | null;
};
export type MirrorInspectionLike = {
  url: string;
  host: string;
  port: number;
  provider: ProviderId | null;
  deployKeyUrl: string | null;
  fingerprintsSource: string | null;
  reachable: boolean;
  hostKeys: HostKeyView[];
  verdict: "PUBLISHED" | "CONFIRM" | "MISMATCH" | "UNREACHABLE";
};

const PROVIDER_NAMES: Record<ProviderId, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};
const HOST_KEY_SHAPE = /^[a-z0-9-]{1,64} [A-Za-z0-9+/]{16,8192}={0,2}$/;
const IN_FLIGHT = new Set(["QUEUED", "RESERVED"]);

/** Mirror controls need `manage`; the server rechecks live manage on every call. */
export function mirrorControls(bits: readonly string[]): { visible: boolean } {
  return { visible: bits.includes("manage") };
}

export function splitHostKeys(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Pasted (advanced) host keys: 1 to 8 full `<type> <base64>` lines. */
export function pastedHostKeysValid(text: string): boolean {
  const keys = splitHostKeys(text);
  return keys.length >= 1 && keys.length <= 8 && keys.every((key) => HOST_KEY_SHAPE.test(key));
}

type TestState =
  | { kind: "untested" }
  | { kind: "running" }
  | { kind: "failed"; code: string; overridable: boolean }
  | { kind: "interrupted" };

function testState(attempt: AttemptView | null | undefined, firstKey: boolean): TestState {
  if (!attempt) return { kind: "untested" };
  if (IN_FLIGHT.has(attempt.state)) return { kind: "running" };
  if (attempt.state === "FAILED") {
    const code = attempt.resultCode ?? "SSH_REJECTED";
    return { kind: "failed", code, overridable: firstKey && code !== "HOST_KEY_MISMATCH" };
  }
  // A passing test activates the key at once, so a pending key never shows one.
  return { kind: "interrupted" };
}

/**
 * The panel's state machine. Every state names the next step:
 * setup → add the key and test it → connected (push, rotate, remove).
 */
export type MirrorViewState =
  | { kind: "setup" }
  | { kind: "add-key"; key: MirrorKeyView; test: TestState }
  | {
      kind: "connected";
      key: MirrorKeyView;
      pushing: boolean;
      lastPush: AttemptView | null;
      justVerified: boolean;
      rotation: { key: MirrorKeyView; test: TestState } | null;
    };

export function mirrorViewState(status: MirrorStatusLike): MirrorViewState {
  if (status.active) {
    const last = status.lastAttempt ?? null;
    return {
      kind: "connected",
      key: status.active,
      pushing:
        (!!last && last.action === "PUSH" && IN_FLIGHT.has(last.state)) ||
        (!!status.lastPush && IN_FLIGHT.has(status.lastPush.state)),
      lastPush: status.lastPush ?? null,
      justVerified: !status.lastPush && last?.action === "ACTIVATE" && last.state === "COMPLETED",
      rotation: status.pending
        ? { key: status.pending, test: testState(status.lastTest, false) }
        : null,
    };
  }
  if (status.pending)
    return { kind: "add-key", key: status.pending, test: testState(status.lastTest, true) };
  return { kind: "setup" };
}

/**
 * An inspection result applies only to the exact URL still in the field: a
 * reply that arrives after the user edited the URL is never approvable.
 */
export function currentInspection<T>(
  data: T | undefined,
  inspectedUrl: string | undefined,
  fieldUrl: string,
): T | null {
  return data !== undefined && inspectedUrl !== undefined && inspectedUrl === fieldUrl.trim()
    ? data
    : null;
}

/** Which host keys the setup may approve, and how, for a given inspection. */
export function setupApproval(
  inspection: MirrorInspectionLike | null,
  choice: { confirmed: boolean; pasted: string | null },
): { hostKeys: string[]; hostKeyCheck: "PUBLISHED" | "CONFIRMED" } | null {
  if (!inspection || inspection.verdict === "MISMATCH") return null;
  // Pasting full keys is itself the user's explicit approval.
  if (choice.pasted !== null)
    return pastedHostKeysValid(choice.pasted)
      ? { hostKeys: splitHostKeys(choice.pasted), hostKeyCheck: "CONFIRMED" }
      : null;
  if (inspection.verdict === "PUBLISHED")
    return {
      hostKeys: inspection.hostKeys.filter((k) => k.check === "PUBLISHED").map((k) => k.key),
      hostKeyCheck: "PUBLISHED",
    };
  if (inspection.verdict === "CONFIRM" && choice.confirmed)
    return { hostKeys: inspection.hostKeys.map((k) => k.key), hostKeyCheck: "CONFIRMED" };
  return null;
}

const KNOWN_RESULTS = new Set([
  "HOST_KEY_MISMATCH",
  "KEY_NOT_ADDED",
  "REPO_NOT_FOUND",
  "READ_ONLY_KEY",
  "REMOTE_DIVERGED",
  "NETWORK_UNAVAILABLE",
  "PUSHED",
  "RECONCILED",
  "VERIFIED",
]);
/** i18n key under `settings.mirror.results` for an attempt outcome. */
export function attemptResultKey(attempt: Pick<AttemptView, "state" | "resultCode">): string {
  if (IN_FLIGHT.has(attempt.state)) return "running";
  if (attempt.state === "UNKNOWN") return "unknown";
  if (attempt.state === "CANCELLED") return "cancelled";
  const code = attempt.resultCode ?? "";
  if (KNOWN_RESULTS.has(code)) return code;
  return attempt.state === "COMPLETED" ? "PUSHED" : "other";
}

const UNSETTLED = new Set(["QUEUED", "RESERVED", "UNKNOWN"]);
/** Poll while any attempt the panel shows may still change (an UNKNOWN push keeps reconciling). */
export function mirrorNeedsPolling(status: MirrorStatusLike): boolean {
  return [status.lastAttempt, status.lastTest, status.lastPush].some(
    (attempt) => !!attempt && UNSETTLED.has(attempt.state),
  );
}

/** Summary word for the last push: an unknown outcome is never called a failure. */
export function pushSummaryKey(state: string): "ok" | "failed" | "unknown" | "cancelled" {
  if (state === "COMPLETED") return "ok";
  if (state === "FAILED") return "failed";
  if (state === "CANCELLED") return "cancelled";
  return "unknown";
}

const URL_REASONS = new Set([
  "NOT_A_GIT_URL",
  "SSH_USER_NOT_GIT",
  "HTTPS_PORT",
  "PRIVATE_NETWORK_HOST",
  "HOST_NOT_FOUND",
  "HOST_KEY_MISMATCH",
  "HOST_KEYS_UNCONFIRMED",
]);
/** The server's named refusal (a fixed code), if any. */
export function mirrorErrorReason(error: unknown): string | null {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason;
  return typeof reason === "string" && URL_REASONS.has(reason) ? reason : null;
}

function ReasonError({ error, testId }: { error: unknown; testId: string }) {
  const { t } = useTranslation("kb");
  const reason = mirrorErrorReason(error);
  if (!reason) return <ControlError error={error} testId={testId} />;
  return (
    <p role="alert" data-testid={testId} data-reason={reason} className="text-sm text-destructive">
      {t(`settings.mirror.reasons.${reason}`)}
    </p>
  );
}

function Note({
  tone,
  children,
  testId,
}: {
  tone: "info" | "success" | "warning";
  children: React.ReactNode;
  testId?: string;
}) {
  const Icon = tone === "success" ? CircleCheck : tone === "warning" ? TriangleAlert : Info;
  const toneClass =
    tone === "warning"
      ? "border-destructive/40 text-foreground"
      : tone === "success"
        ? "border-primary/40 bg-primary/5"
        : "bg-muted/50";
  return (
    <div
      role={tone === "warning" ? "alert" : "note"}
      data-testid={testId}
      data-tone={tone}
      className={`flex min-w-0 gap-2 rounded-md border p-3 text-sm ${toneClass}`}
    >
      <Icon
        aria-hidden
        className={`mt-0.5 size-4 shrink-0 ${tone === "warning" ? "text-destructive" : tone === "success" ? "text-primary" : "text-muted-foreground"}`}
      />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-[44px] items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ExternalLink aria-hidden className="size-4" />
    </a>
  );
}

function Step({
  n,
  title,
  children,
  testId,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  const id = `${testId}-title`;
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className="min-w-0 space-y-3 rounded-lg border p-4"
    >
      <h3 id={id} className="flex items-center gap-2 font-semibold">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs"
        >
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Fingerprints({ keys }: { keys: HostKeyView[] }) {
  return (
    <ul className="min-w-0 space-y-1" data-testid="mirror-fingerprints">
      {keys.map((key) => (
        <li key={key.fingerprint} className="min-w-0 text-xs">
          <span className="text-muted-foreground">{key.algorithm}</span>{" "}
          <span className="break-all font-mono">{key.fingerprint}</span>
        </li>
      ))}
    </ul>
  );
}

function HostKeyStep({
  inspection,
  confirmed,
  onConfirmed,
  pasted,
  onPasted,
}: {
  inspection: MirrorInspectionLike;
  confirmed: boolean;
  onConfirmed: (value: boolean) => void;
  pasted: string | null;
  onPasted: (value: string | null) => void;
}) {
  const { t } = useTranslation("kb");
  const provider = inspection.provider ? PROVIDER_NAMES[inspection.provider] : null;
  const where = `${inspection.host}${inspection.port === 22 ? "" : `:${inspection.port}`}`;
  return (
    <Step n={2} title={t("settings.mirror.steps.hostKeys")} testId="mirror-step-host-keys">
      <div data-testid="mirror-verdict" data-verdict={inspection.verdict} className="space-y-3">
        {inspection.verdict === "PUBLISHED" && (
          <Note tone="success">
            <p>{t("settings.mirror.hostKeys.published", { provider })}</p>
            <Fingerprints keys={inspection.hostKeys.filter((k) => k.check === "PUBLISHED")} />
            {inspection.fingerprintsSource && (
              <a
                href={inspection.fingerprintsSource}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center text-xs underline underline-offset-4"
              >
                {t("settings.mirror.hostKeys.source", { provider })}
              </a>
            )}
          </Note>
        )}
        {inspection.verdict === "MISMATCH" && (
          <Note tone="warning">
            <p className="font-medium">{t("settings.mirror.hostKeys.mismatchTitle")}</p>
            <p>{t("settings.mirror.hostKeys.mismatch", { provider: provider ?? where })}</p>
          </Note>
        )}
        {inspection.verdict === "UNREACHABLE" && (
          <Note tone="warning">
            <p>{t("settings.mirror.hostKeys.unreachable", { host: where })}</p>
          </Note>
        )}
        {inspection.verdict === "CONFIRM" && pasted === null && (
          <div className="space-y-3">
            <Note tone="info">
              <p>{t("settings.mirror.hostKeys.confirm", { host: where })}</p>
              <Fingerprints keys={inspection.hostKeys} />
            </Note>
            <CheckRow
              id="mirror-confirm-fingerprints"
              checked={confirmed}
              disabled={false}
              onToggle={() => onConfirmed(!confirmed)}
              label={t("settings.mirror.hostKeys.confirmCheck")}
            />
          </div>
        )}
      </div>
      {inspection.verdict !== "PUBLISHED" && inspection.verdict !== "MISMATCH" && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-[44px] px-0"
            aria-expanded={pasted !== null}
            data-testid="mirror-advanced"
            onClick={() => onPasted(pasted === null ? "" : null)}
          >
            {pasted === null
              ? t("settings.mirror.hostKeys.advancedOpen")
              : t("settings.mirror.hostKeys.advancedClose")}
          </Button>
          {pasted !== null && (
            <AdvancedHostKeys value={pasted} onChange={(value) => onPasted(value)} />
          )}
        </div>
      )}
    </Step>
  );
}

function AdvancedHostKeys({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation("kb");
  const form = useForm({ defaultValues: { hostKeys: value } });
  const invalid = value.trim().length > 0 && !pastedHostKeysValid(value);
  return (
    <form.Field name="hostKeys" listeners={{ onChange: ({ value: next }) => onChange(next) }}>
      {(field) => (
        <TextareaField
          field={field}
          label={t("settings.mirror.hostKeys.pasteLabel")}
          autoComplete="off"
          spellCheck={false}
          rows={3}
          inputClassName="font-mono text-xs"
          description={
            invalid
              ? t("settings.mirror.hostKeys.pasteInvalid")
              : t("settings.mirror.hostKeys.pasteHint")
          }
        />
      )}
    </form.Field>
  );
}

function SetupWizard({ kb, onDone }: { kb: KbLike; onDone: () => void }) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const [confirmed, setConfirmed] = useState(false);
  const [pasted, setPasted] = useState<string | null>(null);
  const [fieldUrl, setFieldUrl] = useState("");
  const inspect = useMutation(orpc.kbMirror.inspect.mutationOptions());
  const configure = useMutation(
    orpc.kbMirror.configure.mutationOptions({
      onSuccess: () => {
        if (!session.current) return;
        attempt.renew();
        onDone();
      },
    }),
  );
  const inspection = currentInspection(inspect.data, inspect.variables?.url, fieldUrl);
  // Any edit discards every choice made for the previous URL.
  const restart = () => {
    configure.reset();
    setConfirmed(false);
    setPasted(null);
  };
  const form = useForm({
    defaultValues: { url: "" },
    onSubmit: ({ value }) => {
      restart();
      setFieldUrl(value.url);
      inspect.mutate({ kbId: kb.id, url: value.url.trim() });
    },
  });
  const approval = setupApproval(inspection, { confirmed, pasted });
  return (
    <div className="min-w-0 space-y-4" data-testid="mirror-setup">
      <Note tone="info" testId="mirror-next-step">
        <p>{t("settings.mirror.setupIntro")}</p>
      </Note>
      <Step n={1} title={t("settings.mirror.steps.remote")} testId="mirror-step-remote">
        <form
          className="min-w-0 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field
            name="url"
            listeners={{
              onChange: ({ value }) => {
                setFieldUrl(value);
                restart();
              },
            }}
          >
            {(field) => (
              <TextField
                field={field}
                label={t("settings.mirror.url")}
                autoComplete="off"
                inputMode="url"
                inputClassName="font-mono"
                maxLength={1024}
                placeholder={t("settings.mirror.urlPlaceholder")}
                description={t("settings.mirror.urlHint")}
              />
            )}
          </form.Field>
          {inspect.variables?.url === fieldUrl.trim() && (
            <ReasonError error={inspect.error} testId="mirror-error" />
          )}
          <Button
            type="submit"
            data-testid="mirror-inspect"
            className="min-h-[44px]"
            disabled={inspect.isPending && inspect.variables?.url === fieldUrl.trim()}
          >
            {inspect.isPending ? t("settings.mirror.checking") : t("settings.mirror.check")}
          </Button>
        </form>
        {inspection && (
          <div className="min-w-0 space-y-1 text-sm" data-testid="mirror-normalized">
            <p className="font-medium">{t("settings.mirror.normalized")}</p>
            <CopyField value={inspection.url} copyLabel={t("settings.mirror.copyUrl")} />
          </div>
        )}
      </Step>
      {inspection && (
        <HostKeyStep
          inspection={inspection}
          confirmed={confirmed}
          onConfirmed={setConfirmed}
          pasted={pasted}
          onPasted={setPasted}
        />
      )}
      {inspection && inspection.verdict !== "MISMATCH" && (
        <div className="space-y-2">
          <ReasonError error={configure.error} testId="mirror-configure-error" />
          <Button
            type="button"
            data-testid="mirror-configure"
            className="min-h-[44px]"
            disabled={!approval || configure.isPending}
            onClick={() =>
              approval &&
              configure.mutate({
                kbId: kb.id,
                url: inspection.url,
                ...approval,
                idempotencyKey: attempt.key,
              })
            }
          >
            {configure.isPending
              ? t("settings.mirror.configuring")
              : t("settings.mirror.configure")}
          </Button>
          {!approval && (
            <p className="text-xs text-muted-foreground">{t("settings.mirror.configureBlocked")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function DeployKeyStep({ view, n }: { view: MirrorKeyView; n: number }) {
  const { t } = useTranslation("kb");
  const provider = view.provider;
  const repo = view.url.replace(/^ssh:\/\/git@[^/]+\//, "").replace(/\.git$/, "");
  return (
    <Step n={n} title={t("settings.mirror.steps.deployKey")} testId="mirror-step-deploy-key">
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-medium">{t("settings.mirror.publicKey")}</p>
        <CodeSnippet code={view.publicKey} copyLabel={t("settings.mirror.copyPublicKey")} />
        <p className="break-all font-mono text-xs text-muted-foreground">{view.fingerprint}</p>
      </div>
      <ol
        className="list-decimal space-y-1 pl-5 text-sm"
        data-testid="mirror-provider-steps"
        data-provider={provider ?? "other"}
      >
        {(
          t(`settings.mirror.providerSteps.${provider ?? "other"}`, {
            returnObjects: true,
            repo,
          }) as string[]
        ).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      {view.deployKeyUrl && provider && (
        <ExternalButton href={view.deployKeyUrl}>
          {t("settings.mirror.openDeployKeys", { provider: PROVIDER_NAMES[provider] })}
        </ExternalButton>
      )}
      <Note tone="info" testId="mirror-key-guidance">
        <p>{t("settings.mirror.keyGuidance")}</p>
      </Note>
    </Step>
  );
}

function TestStep({
  kb,
  keyId,
  test,
  n,
  onChange,
}: {
  kb: KbLike;
  keyId: string;
  test: TestState;
  n: number;
  onChange: () => void;
}) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const [overriding, setOverriding] = useState(false);
  const activate = useMutation(
    orpc.kbMirror.activate.mutationOptions({
      onSuccess: () => {
        if (session.current) attempt.renew();
        onChange();
      },
    }),
  );
  const override = useMutation(
    orpc.kbMirror.enableUntested.mutationOptions({
      onSuccess: () => {
        if (session.current) {
          attempt.renew();
          setOverriding(false);
        }
        onChange();
      },
      onError: () => {
        if (session.current) setOverriding(false);
      },
    }),
  );
  const running = test.kind === "running" || activate.isPending;
  return (
    <Step n={n} title={t("settings.mirror.steps.test")} testId="mirror-step-test">
      <p className="text-sm text-muted-foreground">{t("settings.mirror.testIntro")}</p>
      <div data-testid="mirror-test-state" data-state={test.kind} className="space-y-2">
        {test.kind === "running" && (
          <p role="status" className="text-sm">
            {t("settings.mirror.results.running")}
          </p>
        )}
        {test.kind === "failed" && (
          <Note tone="warning">
            <p data-testid="mirror-test-result" data-code={test.code}>
              {t(
                `settings.mirror.results.${attemptResultKey({ state: "FAILED", resultCode: test.code })}`,
              )}
            </p>
          </Note>
        )}
        {test.kind === "interrupted" && (
          <p role="status" className="text-sm">
            {t("settings.mirror.results.interrupted")}
          </p>
        )}
      </div>
      <ControlError error={activate.error ?? override.error} testId="mirror-test-error" />
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          data-testid="mirror-test"
          className="min-h-[44px]"
          disabled={running}
          onClick={() => activate.mutate({ kbId: kb.id, idempotencyKey: attempt.key })}
        >
          {running
            ? t("settings.mirror.testing")
            : test.kind === "untested"
              ? t("settings.mirror.test")
              : t("settings.mirror.testAgain")}
        </Button>
        {test.kind === "failed" && test.overridable && (
          <Button
            type="button"
            variant="ghost"
            data-testid="mirror-override"
            className="min-h-[44px]"
            onClick={() => setOverriding(true)}
          >
            {t("settings.mirror.override")}
          </Button>
        )}
      </div>
      <ConfirmDeleteDialog
        open={overriding}
        onOpenChange={(open) => !open && setOverriding(false)}
        title={t("settings.mirror.overrideTitle")}
        description={t("settings.mirror.overrideDescription")}
        confirmToken="ENABLE"
        typePrompt={t("settings.mirror.overridePrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.mirror.overrideAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={override.isPending}
        onConfirm={() => override.mutate({ kbId: kb.id, keyId, idempotencyKey: attempt.key })}
      />
    </Step>
  );
}

function LastPush({ state }: { state: Extract<MirrorViewState, { kind: "connected" }> }) {
  const { t, i18n } = useTranslation("kb");
  if (state.pushing)
    return (
      <p role="status" className="text-sm" data-testid="mirror-last-push" data-state="running">
        {t("settings.mirror.results.pushing")}
      </p>
    );
  const push = state.lastPush;
  if (!push)
    return (
      <Note tone={state.justVerified ? "success" : "info"} testId="mirror-next-step">
        <p>
          {state.justVerified ? t("settings.mirror.justVerified") : t("settings.mirror.noPushYet")}
        </p>
      </Note>
    );
  const key = attemptResultKey(push);
  const when = formatRelativeTime(Date.parse(push.finishedAt ?? push.createdAt), i18n.language);
  const ok = push.state === "COMPLETED";
  return (
    <div className="space-y-2" data-testid="mirror-last-push" data-state={push.state}>
      <p className="text-sm">
        <span className="font-medium">{t("settings.mirror.lastPush")}</span> {when}
        {" · "}
        {t(`settings.mirror.lastPushSummary.${pushSummaryKey(push.state)}`)}
      </p>
      {!ok && (
        <Note tone="warning">
          <p data-testid="mirror-push-result" data-code={push.resultCode ?? ""}>
            {t(`settings.mirror.results.${key}`)}
          </p>
        </Note>
      )}
    </div>
  );
}

function ConnectedCard({
  kb,
  state,
  onChange,
  onRemove,
}: {
  kb: KbLike;
  state: Extract<MirrorViewState, { kind: "connected" }>;
  onChange: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const settle = {
    onSuccess: () => {
      if (session.current) attempt.renew();
      onChange();
    },
  };
  const push = useMutation(orpc.kbMirror.push.mutationOptions(settle));
  const rotate = useMutation(orpc.kbMirror.rotate.mutationOptions(settle));
  const provider = state.key.provider ? PROVIDER_NAMES[state.key.provider] : null;
  return (
    <section
      data-testid="mirror-connected"
      aria-labelledby="mirror-connected-title"
      className="min-w-0 space-y-4 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CircleCheck aria-hidden className="size-5 text-primary" />
        <h3 id="mirror-connected-title" className="font-semibold">
          {provider
            ? t("settings.mirror.connectedTo", { provider })
            : t("settings.mirror.connected")}
        </h3>
      </div>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-medium">{t("settings.mirror.url")}</p>
        <CopyField value={state.key.url} copyLabel={t("settings.mirror.copyUrl")} />
      </div>
      <p className="text-sm text-muted-foreground">{t("settings.mirror.behaviour")}</p>
      <LastPush state={state} />
      <ControlError error={push.error ?? rotate.error} testId="mirror-error" />
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          data-testid="mirror-push"
          className="min-h-[44px]"
          disabled={push.isPending || state.pushing}
          onClick={() => push.mutate({ kbId: kb.id, idempotencyKey: attempt.key })}
        >
          {state.pushing ? t("settings.mirror.pushing") : t("settings.mirror.push")}
        </Button>
        {!state.rotation && (
          <Button
            type="button"
            variant="outline"
            data-testid="mirror-rotate"
            className="min-h-[44px]"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate({ kbId: kb.id, idempotencyKey: attempt.key })}
          >
            {rotate.isPending ? t("settings.mirror.rotating") : t("settings.mirror.rotate")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          data-testid="mirror-disconnect"
          className="min-h-[44px] text-destructive"
          onClick={onRemove}
        >
          {t("settings.mirror.disconnect")}
        </Button>
      </div>
      <details className="text-sm">
        <summary className="flex min-h-[44px] cursor-pointer items-center">
          {t("settings.mirror.details")}
        </summary>
        <div className="min-w-0 space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">{t("settings.mirror.publicKey")}</p>
          {/* Still needed after an override, to add the key to the remote. */}
          <CodeSnippet code={state.key.publicKey} copyLabel={t("settings.mirror.copyPublicKey")} />
          <p className="text-xs">
            <span className="text-muted-foreground">
              {t("settings.mirror.deployKeyFingerprint")}
            </span>{" "}
            <span className="break-all font-mono">{state.key.fingerprint}</span>
          </p>
          <p className="text-xs text-muted-foreground">{t("settings.mirror.approvedHostKeys")}</p>
          <Fingerprints keys={state.key.hostKeys} />
        </div>
      </details>
    </section>
  );
}

/** Read-only projection of the current state; used by the panel and its tests. */
export function MirrorStatusView({
  kb,
  status,
  onChange,
  onRemove,
}: {
  kb: KbLike;
  status: MirrorStatusLike;
  onChange: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("kb");
  const view = mirrorViewState(status);
  if (view.kind === "setup") return <SetupWizard kb={kb} onDone={onChange} />;
  if (view.kind === "add-key")
    return (
      <div className="min-w-0 space-y-4" data-testid="mirror-add-key">
        <Note tone="info" testId="mirror-next-step">
          <p>{t("settings.mirror.addKeyIntro")}</p>
        </Note>
        <DeployKeyStep view={view.key} n={3} />
        {/* Keyed by key: a replaced pending key never inherits an open confirmation. */}
        <TestStep
          key={view.key.keyId}
          kb={kb}
          keyId={view.key.keyId}
          test={view.test}
          n={4}
          onChange={onChange}
        />
        <Button
          type="button"
          variant="ghost"
          data-testid="mirror-start-over"
          className="min-h-[44px]"
          onClick={onRemove}
        >
          {t("settings.mirror.startOver")}
        </Button>
      </div>
    );
  return (
    <div className="min-w-0 space-y-4">
      <ConnectedCard kb={kb} state={view} onChange={onChange} onRemove={onRemove} />
      {view.rotation && (
        <div className="min-w-0 space-y-4" data-testid="mirror-rotation">
          <Note tone="info" testId="mirror-next-step">
            <p>{t("settings.mirror.rotationIntro", { fingerprint: view.key.fingerprint })}</p>
          </Note>
          <DeployKeyStep view={view.rotation.key} n={1} />
          <TestStep
            key={view.rotation.key.keyId}
            kb={kb}
            keyId={view.rotation.key.keyId}
            test={view.rotation.test}
            n={2}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

function MirrorPanelBody({ kb }: { kb: KbLike }) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const [confirming, setConfirming] = useState(false);
  const statusOptions = orpc.kbMirror.status.queryOptions({ input: { kbId: kb.id }, retry: false });
  const { data, isPending, isError, refetch } = useQuery({
    ...statusOptions,
    refetchInterval: (query) =>
      query.state.data && mirrorNeedsPolling(query.state.data) ? 2000 : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: statusOptions.queryKey });
  const disconnect = useMutation(
    orpc.kbMirror.disconnect.mutationOptions({
      onSuccess: () => {
        if (session.current) {
          attempt.renew();
          setConfirming(false);
        }
        void refresh();
      },
      onError: () => {
        if (session.current) setConfirming(false);
      },
    }),
  );
  if (isPending)
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (isError || !data)
    return <InlineRetry message={t("settings.mirror.loadFailed")} onRetry={() => refetch()} />;
  return (
    <div className="min-w-0 space-y-4" data-testid="mirror-status" data-state={data.state}>
      <MirrorStatusView
        kb={kb}
        status={data}
        onChange={() => void refresh()}
        onRemove={() => setConfirming(true)}
      />
      <ControlError error={disconnect.error} testId="mirror-remove-error" />
      <ConfirmDeleteDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={t("settings.mirror.disconnectConfirmTitle")}
        description={t("settings.mirror.disconnectConfirmDescription")}
        confirmToken="DELETE"
        typePrompt={t("settings.mirror.disconnectPrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.mirror.disconnectAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={disconnect.isPending}
        onConfirm={() => disconnect.mutate({ kbId: kb.id, idempotencyKey: attempt.key })}
      />
    </div>
  );
}

/**
 * Manage-only push-mirror setup and status. Shows only public key halves and
 * the approved host keys; there is no private-key read path anywhere.
 */
export function MirrorPanel({ kb }: { kb: KbLike }) {
  const { t } = useTranslation("kb");
  if (!mirrorControls(kb.capabilities).visible) return null;
  return (
    <section
      data-testid="mirror-panel"
      aria-labelledby="kb-mirror-title"
      className="min-w-0 space-y-4"
    >
      <header className="space-y-1">
        <h2 id="kb-mirror-title" className="text-lg font-semibold">
          {t("settings.mirror.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("settings.mirror.description")}</p>
      </header>
      <MirrorPanelBody kb={kb} />
    </section>
  );
}
