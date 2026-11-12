import { Button } from "@knowledge-base/ui/components/button";
import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextareaField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { ControlError } from "@/components/kb/profile-panel";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { orpc } from "@/utils/orpc";

/** The server's private-network egress refusal (R2-18), told apart from a malformed URL. */
function mirrorPrivateHost(error: unknown): boolean {
  return (error as { data?: { reason?: unknown } } | null)?.data?.reason === "PRIVATE_NETWORK_HOST";
}

type KbLike = { id: string; capabilities: readonly string[] };

type HostKeyView = { algorithm: string; key: string; fingerprint: string };
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
};
export type MirrorStatusLike = {
  kbId: string;
  state: "DISCONNECTED" | "PENDING" | "ACTIVE";
  remoteVersion: number;
  active: MirrorKeyView | null;
  pending: MirrorKeyView | null;
  pushEnabled: boolean;
  lastAttempt?: { attemptId: string; state: string; resultCode: string | null } | null;
};

// Client hints only; the server's strict parser is the authority.
const URL_SHAPE = /^ssh:\/\/git@[A-Za-z0-9.[\]:-]+(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9._-]+){2,8}$/;
const HOST_KEY_SHAPE = /^[a-z0-9-]{1,64} [A-Za-z0-9+/]{16,8192}={0,2}$/;

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

export type MirrorFormIssue = "url" | "hostKeys";
export function mirrorFormIssues(draft: { url: string; hostKeys: string }): MirrorFormIssue[] {
  const issues: MirrorFormIssue[] = [];
  const url = draft.url.trim();
  if (!URL_SHAPE.test(url) || !url.endsWith(".git")) issues.push("url");
  const keys = splitHostKeys(draft.hostKeys);
  if (keys.length < 1 || keys.length > 8 || keys.some((key) => !HOST_KEY_SHAPE.test(key)))
    issues.push("hostKeys");
  return issues;
}

function KeyCard({ view, label }: { view: MirrorKeyView; label: string }) {
  const { t } = useTranslation("kb");
  return (
    <div
      data-testid={`mirror-key-${view.state.toLowerCase()}`}
      data-state={view.state}
      className="min-w-0 space-y-3 rounded-md border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{label}</h3>
        <span className="text-xs text-muted-foreground">
          {t("settings.mirror.version", { key: view.keyVersion, remote: view.remoteVersion })}
        </span>
      </div>
      <div className="space-y-1 text-sm">
        <p className="font-medium">{t("settings.mirror.url")}</p>
        <CopyField value={view.url} copyLabel={t("settings.mirror.copyUrl")} />
      </div>
      <div className="space-y-1 text-sm">
        <p className="font-medium">{t("settings.mirror.publicKey")}</p>
        <CodeSnippet code={view.publicKey} copyLabel={t("settings.mirror.copyPublicKey")} />
        <p className="break-all font-mono text-xs text-muted-foreground">{view.fingerprint}</p>
        <p className="text-xs text-muted-foreground">{t("settings.mirror.publicKeyHint")}</p>
      </div>
      <div className="space-y-2 text-sm">
        <p className="font-medium">{t("settings.mirror.hostKeys")}</p>
        <ul className="space-y-2">
          {view.hostKeys.map((hostKey) => (
            <li key={hostKey.fingerprint} className="min-w-0 space-y-1">
              <CodeSnippet code={hostKey.key} copyLabel={t("settings.mirror.copyHostKey")} />
              <p className="break-all font-mono text-xs">{hostKey.fingerprint}</p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t("settings.mirror.hostKeysVerify")}</p>
      </div>
    </div>
  );
}

/** Read-only projection: public halves, exact host keys, state and the compromise consequence. */
export function MirrorStatusView({ status }: { status: MirrorStatusLike }) {
  const { t } = useTranslation("kb");
  return (
    <div className="min-w-0 space-y-4" data-testid="mirror-status" data-state={status.state}>
      <p className="text-sm">
        {status.state === "DISCONNECTED"
          ? t("settings.mirror.disconnected")
          : t(`settings.mirror.states.${status.state}`)}
      </p>
      <p
        data-testid="mirror-compromise-warning"
        role="note"
        className="rounded-md border border-destructive/40 p-3 text-sm"
      >
        {t("settings.mirror.compromise")}
      </p>
      {status.lastAttempt && (
        <p role="status" className="text-sm" data-testid="mirror-attempt">
          {t(`settings.mirror.attempts.${status.lastAttempt.state}`, {
            defaultValue: t("settings.mirror.attempts.UNKNOWN"),
          })}
        </p>
      )}
      {status.active && <KeyCard view={status.active} label={t("settings.mirror.active")} />}
      {status.pending && (
        <>
          <KeyCard view={status.pending} label={t("settings.mirror.pending")} />
          <p className="text-xs text-muted-foreground">{t("settings.mirror.pendingHint")}</p>
        </>
      )}
    </div>
  );
}

function ConfigureForm({ kb, onDone }: { kb: KbLike; onDone: () => void }) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const [issues, setIssues] = useState<MirrorFormIssue[]>([]);
  const configure = useMutation(
    orpc.kbMirror.configure.mutationOptions({
      onSuccess: () => {
        if (!session.current) return;
        attempt.renew();
        onDone();
      },
    }),
  );
  const form = useForm({
    defaultValues: { url: "", hostKeys: "" },
    onSubmit: ({ value }) => {
      const found = mirrorFormIssues(value);
      setIssues(found);
      if (found.length > 0) return;
      configure.mutate({
        kbId: kb.id,
        url: value.url.trim(),
        hostKeys: splitHostKeys(value.hostKeys),
        idempotencyKey: attempt.key,
      });
    },
  });
  return (
    <form
      className="min-w-0 space-y-3"
      aria-labelledby="mirror-configure-title"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <h3 id="mirror-configure-title" className="font-semibold">
        {t("settings.mirror.configureTitle")}
      </h3>
      <form.Field name="url">
        {(field) => (
          <TextField
            field={field}
            label={t("settings.mirror.url")}
            autoComplete="off"
            inputMode="url"
            inputClassName="font-mono"
            maxLength={1024}
            placeholder={t("settings.mirror.urlPlaceholder")}
            description={issues.includes("url") ? t("settings.mirror.issues.url") : undefined}
          />
        )}
      </form.Field>
      <form.Field name="hostKeys">
        {(field) => (
          <TextareaField
            field={field}
            label={t("settings.mirror.hostKeys")}
            autoComplete="off"
            spellCheck={false}
            rows={3}
            description={
              issues.includes("hostKeys")
                ? t("settings.mirror.issues.hostKeys")
                : t("settings.mirror.hostKeysHint")
            }
          />
        )}
      </form.Field>
      {mirrorPrivateHost(configure.error) ? (
        <p role="alert" data-testid="mirror-error" className="text-sm text-destructive">
          {t("settings.mirror.privateHost")}
        </p>
      ) : (
        <ControlError error={configure.error} testId="mirror-error" />
      )}
      <Button
        type="submit"
        data-testid="mirror-configure"
        className="min-h-[44px]"
        disabled={configure.isPending}
      >
        {configure.isPending ? t("settings.mirror.configuring") : t("settings.mirror.configure")}
      </Button>
    </form>
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
      ["QUEUED", "RESERVED", "UNKNOWN"].includes(query.state.data?.lastAttempt?.state ?? "")
        ? 2000
        : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: statusOptions.queryKey });
  const activate = useMutation(
    orpc.kbMirror.activate.mutationOptions({
      onSuccess: () => {
        if (session.current) attempt.renew();
        void refresh();
      },
    }),
  );
  const push = useMutation(
    orpc.kbMirror.push.mutationOptions({
      onSuccess: () => {
        if (session.current) attempt.renew();
        void refresh();
      },
    }),
  );
  const rotate = useMutation(
    orpc.kbMirror.rotate.mutationOptions({
      onSuccess: () => {
        if (session.current) attempt.renew();
        void refresh();
      },
    }),
  );
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
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (isError || !data)
    return <InlineRetry message={t("settings.mirror.loadFailed")} onRetry={() => refetch()} />;
  return (
    <div className="min-w-0 space-y-6">
      <MirrorStatusView status={data} />
      <div className="flex flex-wrap gap-3">
        {data.pending && (
          <Button
            type="button"
            className="min-h-[44px]"
            disabled={activate.isPending}
            onClick={() => activate.mutate({ kbId: kb.id, idempotencyKey: attempt.key })}
          >
            {t("settings.mirror.activate")}
          </Button>
        )}
        {data.pushEnabled && (
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            disabled={push.isPending}
            onClick={() => push.mutate({ kbId: kb.id, idempotencyKey: attempt.key })}
          >
            {t("settings.mirror.push")}
          </Button>
        )}
        {data.active && (
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
        {data.state !== "DISCONNECTED" && (
          <Button
            type="button"
            variant="destructive"
            data-testid="mirror-disconnect"
            className="min-h-[44px]"
            onClick={() => setConfirming(true)}
          >
            {t("settings.mirror.disconnect")}
          </Button>
        )}
      </div>
      <ControlError
        error={activate.error ?? push.error ?? rotate.error ?? disconnect.error}
        testId="mirror-error"
      />
      <ConfigureForm kb={kb} onDone={() => void refresh()} />
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
 * Manage-only push-mirror controls. Shows only public key halves and the exact
 * approved host keys; there is no private-key read path anywhere.
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
