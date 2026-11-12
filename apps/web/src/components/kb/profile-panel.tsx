import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { Label } from "@knowledge-base/ui/components/label";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { useTransientSecretMutation } from "@/hooks/use-transient-secret-mutation";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

type ListMine = Awaited<ReturnType<AppRouterClient["embeddingProviders"]["listMine"]>>;
/** An owned provider as the list shows it: public summary plus its latest probe state. */
export type ProviderRow = ListMine["items"][number];
/** The public provider projection (no probe state), e.g. a create/probe response. */
export type ProviderSummary = Omit<ProviderRow, "probe">;
type ProfileGet = Awaited<ReturnType<AppRouterClient["kbIndex"]["profile"]>>;
type IndexStatus = ProfileGet["index"];
type KbLike = { id: string; capabilities: readonly string[] };

// ---- shared control helpers (members and sealed panels reuse these) ----------

export type ControlErrorKind = "denied" | "conflict" | "invalid" | "retry";

/** The oRPC error code of a failed mutation, if any. */
export const controlErrorCode = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; data?: { code?: unknown } } | null;
  if (typeof e?.code === "string") return e.code;
  return typeof e?.data?.code === "string" ? e.data.code : undefined;
};

/** Localized state for a failed control mutation; the server stays the authority. */
export function describeControlError(error: unknown): ControlErrorKind {
  switch (controlErrorCode(error)) {
    case "NOT_FOUND":
    case "FORBIDDEN":
      return "denied";
    case "CONFLICT":
      return "conflict";
    case "BAD_REQUEST":
      return "invalid";
    default:
      return "retry";
  }
}

export function ControlError({
  error,
  ns = "kb",
  testId = "control-error",
}: {
  error: unknown;
  ns?: "kb" | "settings";
  testId?: string;
}) {
  const { t } = useTranslation(ns);
  if (!error) return null;
  const kind = describeControlError(error);
  return (
    <p role="alert" data-testid={testId} data-kind={kind} className="text-sm text-destructive">
      {t(ns === "kb" ? `settings.errors.${kind}` : `providers.errors.${kind}`)}
    </p>
  );
}

// ---- providers ---------------------------------------------------------------

const PROVIDER_LIST_ROOT: readonly unknown[] = orpc.embeddingProviders.listMine.key();

export type TrackedProbe = { providerId: string; revision: number };
export type ProbeOutcome = "probing" | "ready" | "failed" | "timeout" | "superseded";

/**
 * What a row says about its latest probe. The server reports the probe's
 * state: pending, ready, or terminal `failed`/`timeout` — a probe
 * that fails in the worker or stops making progress never stays "Probing…".
 * For a probe started on this page (`probe`), success is only that exact
 * revision reporting ready; a provider revoked (or gone) meanwhile is a
 * failure, never success. Rows this page did not probe show only pending
 * and terminal-failure states (null otherwise).
 */
export function probeOutcome(
  probe: TrackedProbe | undefined,
  summary: ProviderRow | undefined,
): ProbeOutcome | null {
  if (!summary || summary.status === "revoked") return probe ? "failed" : null;
  if (probe && summary.revision !== probe.revision) return "superseded";
  switch (summary.probe.state) {
    case "ready":
      return probe ? "ready" : null;
    case "failed":
      return "failed";
    case "timeout":
      return "timeout";
    default:
      return "probing";
  }
}

const PROBE_TONE: Record<ProbeOutcome, PillTone> = {
  probing: "info",
  ready: "good",
  failed: "bad",
  timeout: "bad",
  superseded: "muted",
};

type ProbeFailure = NonNullable<ProviderRow["probe"]["failure"]>;

/** The owner-facing cause of a failed provider request (stable codes only, no provider text). */
function probeFailureText(
  failure: ProbeFailure,
  dimensions: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (failure.kind) {
    case "unreachable":
      return t("providers.probeFailure.unreachable");
    case "http_status":
      return t(
        failure.status === 401 || failure.status === 403
          ? "providers.probeFailure.httpAuth"
          : "providers.probeFailure.httpStatus",
        { status: failure.status },
      );
    case "dimension_mismatch":
      return t("providers.probeFailure.dimensionMismatch", {
        received: failure.received,
        expected: dimensions,
      });
    case "bad_response":
      return t("providers.probeFailure.badResponse");
  }
}

export function ProviderListView({
  providers,
  probes,
  onProbe,
  onRevoke,
}: {
  providers: readonly ProviderRow[];
  probes: Readonly<Record<string, TrackedProbe>>;
  onProbe: (provider: ProviderRow) => void;
  onRevoke: (provider: ProviderRow) => void;
}) {
  const { t } = useTranslation("settings");
  if (providers.length === 0)
    return <p className="text-sm text-muted-foreground">{t("providers.empty")}</p>;
  return (
    <ul className="divide-y rounded-md border">
      {providers.map((provider) => {
        const outcome = probeOutcome(probes[provider.providerId], provider);
        const terminal = outcome === "failed" || outcome === "timeout";
        const reason =
          provider.status === "revoked" ? "revoked" : (provider.probe.reason ?? "provider_error");
        // A known cause replaces the generic "rejected or failed" line (R2-26).
        const causeKnown = reason === "provider_error" && provider.probe.failure !== null;
        return (
          <li
            key={provider.providerId}
            data-testid="provider-row"
            data-provider-id={provider.providerId}
            data-status={provider.status}
            data-revision={provider.revision}
            data-probe={outcome ?? undefined}
            className="flex min-w-0 flex-wrap items-center gap-2 p-3"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="truncate text-sm font-medium">{provider.name}</p>
              <p className="text-xs text-muted-foreground">
                {t("providers.line", { model: provider.model, dimensions: provider.dimensions })} ·{" "}
                {t("providers.revision", { revision: provider.revision })}
              </p>
              {outcome && (
                <p
                  role={terminal ? "alert" : "status"}
                  className={
                    terminal
                      ? "flex flex-wrap items-center gap-1.5 text-xs text-destructive"
                      : "flex flex-wrap items-center gap-1.5 text-xs"
                  }
                >
                  <StatusPill tone={PROBE_TONE[outcome]}>
                    {t(`providers.probeState.${outcome}`)}
                  </StatusPill>
                  {terminal && !causeKnown && <span>{t(`providers.probeReason.${reason}`)}</span>}
                  {outcome === "probing" && !provider.probe.failure && (
                    <span className="text-muted-foreground"> {t("providers.probeProgress")}</span>
                  )}
                </p>
              )}
              {(outcome === "probing" || (terminal && reason === "provider_error")) &&
                provider.probe.failure && (
                  <p className="text-xs text-muted-foreground" data-testid="probe-failure">
                    {t(
                      outcome === "probing"
                        ? "providers.probeRetrying"
                        : "providers.probeFailureLead",
                      { cause: probeFailureText(provider.probe.failure, provider.dimensions, t) },
                    )}
                  </p>
                )}
            </div>
            <span className="rounded border px-1.5 text-xs">
              {t(`providers.status.${provider.status}`)}
            </span>
            {provider.status !== "revoked" && (
              <span className="flex gap-2">
                <Button
                  data-testid="provider-probe"
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => onProbe(provider)}
                >
                  {t("providers.probe")}
                </Button>
                <Button
                  data-testid="provider-revoke"
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => onRevoke(provider)}
                >
                  {t("providers.revoke")}
                </Button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Create → Dialog, and the same form for a re-probe. Endpoint and key exist
 * only in this mounted form and the transport, never mutation variables.
 * Closing retires this session; nothing ever fetches the secret fields back.
 */
function ProviderSecretDialog({
  target,
  onClose,
  onRegistered,
  onSettled,
}: {
  target: { mode: "create" } | { mode: "probe"; provider: ProviderSummary };
  onClose: () => void;
  onRegistered: (probe: TrackedProbe) => void;
  onSettled: () => unknown;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const session = useKbMutationSession();
  const attempt = useRenewableAttemptKey();
  const draft = useRef(0);
  const submittedDraft = useRef(0);
  const done = (result: { provider: ProviderSummary }) => {
    if (!session.current) return;
    attempt.renew();
    onRegistered({ providerId: result.provider.providerId, revision: result.provider.revision });
    if (draft.current === submittedDraft.current) close();
    else {
      create.reset();
      probe.reset();
    }
  };
  const callbacks = {
    onSuccess: done,
    onSettled,
  };
  const create = useTransientSecretMutation(
    orpc.embeddingProviders.create.mutationOptions(),
    callbacks,
  );
  const probe = useTransientSecretMutation(
    orpc.embeddingProviders.probe.mutationOptions(),
    callbacks,
  );
  const form = useForm({
    defaultValues: { name: "", endpointUrl: "", model: "", dimensions: "", apiKey: "" },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .max(120)
          .refine(
            (value) => !value.includes("\0") && (target.mode === "probe" || value.length > 0),
            t("settings:providers.errors.invalid"),
          ),
        endpointUrl: z.string().trim().min(1).max(2048),
        model: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine((value) => !value.includes("\0"), t("settings:providers.errors.invalid")),
        dimensions: z.string().regex(/^\d{1,4}$/),
        apiKey: z
          .string()
          .min(1)
          .max(16384)
          .regex(/^[\x21-\x7e]+$/),
      }),
    },
    onSubmit: ({ value }) => {
      const idempotencyKey =
        draft.current === submittedDraft.current ? attempt.key : attempt.renew();
      const configuration = {
        endpointUrl: value.endpointUrl.trim(),
        model: value.model.trim(),
        dimensions: Number(value.dimensions),
        apiKey: value.apiKey,
        idempotencyKey,
      };
      const submitted =
        target.mode === "probe"
          ? probe.mutate({ ...configuration, providerId: target.provider.providerId })
          : create.mutate({ ...configuration, name: value.name.trim() });
      if (submitted) submittedDraft.current = draft.current;
    },
  });
  function close() {
    session.current = false;
    create.reset();
    probe.reset();
    form.reset();
    onClose();
  }
  const pending = create.isPending || probe.isPending;
  const error = create.error ?? probe.error;
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "probe"
              ? t("settings:providers.probeTitle", { name: target.provider.name })
              : t("settings:providers.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {target?.mode === "probe"
              ? t("settings:providers.probeDescription")
              : t("settings:providers.createDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onChange={() => {
            draft.current += 1;
          }}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          {target?.mode !== "probe" && (
            <form.Field name="name">
              {(field) => (
                <TextField
                  field={field}
                  label={t("settings:providers.name")}
                  autoComplete="off"
                  inputMode="text"
                  maxLength={120}
                />
              )}
            </form.Field>
          )}
          <form.Field name="endpointUrl">
            {(field) => (
              <TextField
                field={field}
                type="url"
                label={t("settings:providers.endpoint")}
                autoComplete="off"
                maxLength={2048}
              />
            )}
          </form.Field>
          <form.Field name="model">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:providers.model")}
                autoComplete="off"
                inputMode="text"
                maxLength={200}
              />
            )}
          </form.Field>
          <form.Field name="dimensions">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:providers.dimensions")}
                autoComplete="off"
                inputMode="numeric"
                maxLength={4}
              />
            )}
          </form.Field>
          <form.Field name="apiKey">
            {(field) => (
              <TextField
                field={field}
                type="password"
                label={t("settings:providers.apiKey")}
                description={t("settings:providers.apiKeyHint")}
                autoComplete="off"
                maxLength={16384}
              />
            )}
          </form.Field>
          <ControlError error={error} ns="settings" />
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={close}>
              {t("settings:providers.cancel")}
            </Button>
            <Button
              type="submit"
              data-testid="provider-save"
              className="min-h-[44px]"
              disabled={pending}
            >
              {pending ? t("settings:providers.saving") : t("settings:providers.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The signed-in user's own providers: create, re-probe, revoke; public projections only. */
export function ProvidersPanel() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [probes, setProbes] = useState<Record<string, TrackedProbe>>({});
  const [target, setTarget] = useState<
    { mode: "create" } | { mode: "probe"; provider: ProviderSummary } | null
  >(null);
  const [revoking, setRevoking] = useState<ProviderSummary | null>(null);
  const list = useInfiniteQuery(
    orpc.embeddingProviders.listMine.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 20, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
      retry: false,
      // Poll only while some probe is still undecided. The server makes every
      // probe terminal (ready, failed or timed out), so polling always stops.
      refetchInterval: (query) => {
        const rows = query.state.data?.pages.flatMap((page) => page?.items ?? []) ?? [];
        const tracked = Object.values(probes).some(
          (probe) =>
            probeOutcome(
              probe,
              rows.find((row) => row.providerId === probe.providerId),
            ) === "probing",
        );
        const untracked = rows.some(
          (row) => probeOutcome(probes[row.providerId], row) === "probing",
        );
        return tracked || untracked ? 1500 : false;
      },
    }),
  );
  const revoke = useMutation(
    orpc.embeddingProviders.revoke.mutationOptions({
      onSuccess: async () => {
        setRevoking(null);
        await queryClient.invalidateQueries({ queryKey: [...PROVIDER_LIST_ROOT] });
      },
    }),
  );
  if (isQueryAccessError(list.error))
    return <InlineRetry message={t("providers.listFailed")} onRetry={() => list.refetch()} />;
  const rows = list.data?.pages.flatMap((page) => page?.items ?? []) ?? [];
  return (
    <section
      data-testid="providers-panel"
      aria-labelledby="providers-title"
      className="min-w-0 space-y-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 id="providers-title" className="text-lg font-semibold">
            {t("providers.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("providers.description")}</p>
        </div>
        <Button
          data-testid="provider-create"
          className="min-h-[44px]"
          onClick={() => setTarget({ mode: "create" })}
        >
          {t("providers.add")}
        </Button>
      </header>
      <QueryBoundary
        query={list}
        errorMessage={t("providers.listFailed")}
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        }
      >
        {() => (
          <ProviderListView
            providers={rows}
            probes={probes}
            onProbe={(provider) => setTarget({ mode: "probe", provider })}
            onRevoke={setRevoking}
          />
        )}
      </QueryBoundary>
      <LoadMore
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => list.fetchNextPage()}
      />
      <ControlError error={revoke.error} ns="settings" />
      {target && (
        <ProviderSecretDialog
          key={target.mode === "probe" ? target.provider.providerId : "create"}
          target={target}
          onClose={() => setTarget(null)}
          onRegistered={(probe) => setProbes((prev) => ({ ...prev, [probe.providerId]: probe }))}
          onSettled={queryClient.invalidateQueries.bind(queryClient, {
            queryKey: [...PROVIDER_LIST_ROOT],
          })}
        />
      )}
      <ConfirmDeleteDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("providers.revokeTitle", { name: revoking?.name ?? "" })}
        description={t("providers.revokeDescription")}
        confirmToken="REVOKE"
        typePrompt={t("providers.revokePrompt")}
        copyAriaLabel={t("providers.copyToken")}
        inputMode="text"
        confirmLabel={t("providers.revokeAction")}
        pendingLabel={t("providers.revoking")}
        isPending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ providerId: revoking.providerId })}
      />
    </section>
  );
}

// ---- KB embedding profile ----------------------------------------------------

export type ProfileChoice = { value: string; providerId: string; revision: number; label: string };

/** Only ready providers are attachable, each bound to its exact current revision. */
export function profileChoices(providers: readonly ProviderSummary[]): ProfileChoice[] {
  return providers
    .filter((provider) => provider.status === "ready")
    .map((provider) => ({
      value: `${provider.providerId}:${provider.revision}`,
      providerId: provider.providerId,
      revision: provider.revision,
      label: `${provider.name} · ${provider.model} · r${provider.revision}`,
    }));
}

/**
 * "No usable providers" is a claim about ALL of them: the provider list pages
 * through revoked and failed ones too, so it holds only once every page is in.
 */
export function showNoProfileChoices(input: {
  choices: number;
  loaded: boolean;
  hasMorePages: boolean;
}): boolean {
  return input.choices === 0 && input.loaded && !input.hasMorePages;
}

export function parseProfileChoice(value: string): { providerId: string; revision: number } | null {
  const match = /^([a-z0-9]{24,32}):([1-9]\d{0,8})$/.exec(value);
  return match ? { providerId: match[1]!, revision: Number(match[2]) } : null;
}

export type GenerationPhase =
  | "none"
  | "pending"
  | "building"
  | "current"
  | "stale"
  | "failed"
  | "unavailable";

/** A completed active generation serves only while the server reports its embedder usable. */
export function generationView(index: IndexStatus): {
  phase: GenerationPhase;
  keepsActive: boolean;
  failed: boolean;
} {
  const activeUsable =
    index.activeGenerationId !== null &&
    index.activeState === "COMPLETE" &&
    index.freshness !== "unavailable" &&
    index.errorCode !== "INDEX_UNAVAILABLE";
  const building =
    index.desiredGenerationId !== null && index.desiredGenerationId !== index.activeGenerationId;
  let phase: GenerationPhase;
  if (building && index.desiredState === "FAILED") phase = "failed";
  else if (building && index.desiredState === "PENDING") phase = "pending";
  else if (building && index.desiredState !== "SUPERSEDED") phase = "building";
  else if (activeUsable) phase = index.freshness === "stale" ? "stale" : "current";
  else if (index.activeGenerationId !== null) phase = "unavailable";
  else phase = "none";
  return {
    phase,
    keepsActive: activeUsable && building && index.desiredState !== "SUPERSEDED",
    failed: phase === "failed",
  };
}

const PHASE_TONE: Record<GenerationPhase, PillTone> = {
  none: "muted",
  pending: "info",
  building: "info",
  current: "good",
  stale: "busy",
  failed: "bad",
  unavailable: "muted",
};

/**
 * Search serves keywords only: the active generation is lexical-only (FTS5, no pinned
 * profile), or it is a hybrid one whose profile can no longer embed queries (revoked or
 * unavailable), so its FTS5 arm serves.
 */
function servesLexically(index: IndexStatus, profile: ProviderSummary | null): boolean {
  if (index.activeGenerationId === null || index.activeState !== "COMPLETE") return false;
  if (index.fingerprint === null && index.dimensions === null) return true;
  return profile !== null && profile.status !== "ready";
}

export function ProfileStatusView({
  profile,
  index,
  canManage = true,
}: {
  profile: ProviderSummary | null;
  index: IndexStatus;
  /** Readers get no chooser, so the lexical notice doesn't point them "below" (R2-27). */
  canManage?: boolean;
}) {
  const { t } = useTranslation("kb");
  const view = generationView(index);
  const servesActive = view.keepsActive || view.phase === "current" || view.phase === "stale";
  return (
    <div data-testid="profile-status" data-phase={view.phase} className="space-y-1 text-sm">
      <p>
        <span className="text-muted-foreground">{t("settings.profile.current")}: </span>
        {profile
          ? t("settings.profile.providerLine", {
              name: profile.name,
              model: profile.model,
              revision: profile.revision,
              dimensions: profile.dimensions,
            })
          : t("settings.profile.none")}
      </p>
      <p>
        <StatusPill tone={PHASE_TONE[view.phase]}>
          {t(`settings.profile.phase.${view.phase}`)}
        </StatusPill>
      </p>
      {view.keepsActive && (
        <p data-testid="profile-keeps-active" className="text-xs text-muted-foreground">
          {t("settings.profile.keepsActive")}
        </p>
      )}
      {/* A newly chosen model's build replaces the lexical index; it is not failing. */}
      {servesLexically(index, profile) &&
        !(profile && (view.phase === "pending" || view.phase === "building")) && (
          <p data-testid="profile-lexical" className="text-xs text-muted-foreground">
            {t(
              `settings.profile.${profile ? "lexicalFailing" : "lexicalNoProfile"}${canManage ? "" : "Reader"}`,
            )}
          </p>
        )}
      {index.rebuildPending ? (
        <p data-testid="profile-rebuild-pending" className="text-xs text-muted-foreground">
          {index.rebuildPending === "EMBEDDING_SETTINGS_CHANGED" && !servesActive
            ? t("settings.profile.settingsChanged")
            : t(`settings.profile.rebuildPending.${index.rebuildPending}`)}
        </p>
      ) : null}
    </div>
  );
}

/** Attach one exact ready provider revision or rebuild; both confirm the cost with RUN. */
export function ProfilePanel({ kb, onDenied }: { kb: KbLike; onDenied: () => void }) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const selectId = useId();
  const canManage = kb.capabilities.includes("manage");
  const [choice, setChoice] = useState("");
  const [confirming, setConfirming] = useState<"profile" | "rebuild" | null>(null);
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const profile = useQuery(
    orpc.kbIndex.profile.queryOptions({
      input: { kbId: kb.id },
      retry: false,
      refetchInterval: (query) => {
        const index = query.state.data?.index;
        const phase = index ? generationView(index).phase : "none";
        return phase === "pending" || phase === "building" ? 3000 : false;
      },
    }),
  );
  const providers = useInfiniteQuery(
    orpc.embeddingProviders.listMine.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 20, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
      enabled: canManage,
      retry: false,
    }),
  );
  const {
    data: systemData,
    isError: systemIsError,
    isSuccess: systemIsSuccess,
    refetch: refetchSystem,
  } = useQuery(
    orpc.embeddingProviders.listSystem.queryOptions({
      enabled: canManage,
      retry: false,
    }),
  );
  const settle = {
    onSuccess: async () => {
      if (session.current) {
        setConfirming(null);
        attempt.renew();
      }
      await queryClient.invalidateQueries({
        queryKey: orpc.kbIndex.profile.queryKey({ input: { kbId: kb.id } }),
      });
    },
    onError: (error: unknown) => {
      if (!session.current) return;
      setConfirming(null);
      if (describeControlError(error) === "denied") onDenied();
    },
  };
  const setProfile = useMutation(orpc.kbIndex.setProfile.mutationOptions(settle));
  const rebuild = useMutation(orpc.kbIndex.rebuild.mutationOptions(settle));
  const choices = profileChoices([
    ...(systemData?.items ?? []),
    ...(providers.data?.pages.flatMap((page) => page?.items ?? []) ?? []),
  ]);
  const selected = parseProfileChoice(choice);
  const pending = setProfile.isPending || rebuild.isPending;
  const phase = profile.data ? generationView(profile.data.index).phase : "none";
  const buildInFlight = phase === "pending" || phase === "building";
  return (
    <section
      data-testid="profile-panel"
      aria-labelledby="kb-profile-title"
      className="min-w-0 space-y-4"
    >
      <header className="space-y-1">
        <h2 id="kb-profile-title" className="text-lg font-semibold">
          {t("settings.profile.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("settings.profile.description")}</p>
      </header>
      {profile.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : profile.isError || !profile.data ? (
        <InlineRetry message={t("settings.profile.loadFailed")} onRetry={() => profile.refetch()} />
      ) : (
        <ProfileStatusView
          profile={profile.data.profile}
          index={profile.data.index}
          canManage={canManage}
        />
      )}
      {canManage && (
        <div className="space-y-3">
          {(providers.isError || systemIsError) && (
            <InlineRetry
              message={t("settings.profile.loadFailed")}
              onRetry={() => {
                void providers.refetch();
                void refetchSystem();
              }}
            />
          )}
          {showNoProfileChoices({
            choices: choices.length,
            loaded: providers.isSuccess && systemIsSuccess,
            hasMorePages: providers.hasNextPage,
          }) ? (
            <p className="text-sm text-muted-foreground">{t("settings.profile.noChoices")}</p>
          ) : (
            <div className="min-w-0 space-y-2">
              <Label htmlFor={selectId}>{t("settings.profile.choice")}</Label>
              <select
                id={selectId}
                data-testid="profile-choice"
                className="min-h-[44px] w-full rounded-md border bg-background px-3 text-sm"
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">{t("settings.profile.choicePlaceholder")}</option>
                {choices.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <LoadMore
            hasNextPage={providers.hasNextPage}
            isFetchingNextPage={providers.isFetchingNextPage}
            onLoadMore={() => providers.fetchNextPage()}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="profile-apply"
              className="min-h-[44px]"
              disabled={!selected || pending}
              onClick={() => setConfirming("profile")}
            >
              {t("settings.profile.apply")}
            </Button>
            <Button
              data-testid="profile-rebuild"
              variant="outline"
              className="min-h-[44px]"
              disabled={pending}
              onClick={() => setConfirming("rebuild")}
            >
              {t("settings.profile.rebuild")}
            </Button>
          </div>
          <ControlError error={setProfile.error ?? rebuild.error} />
          {/* R2-27: only while the queued build has not finished yet. */}
          {(setProfile.isSuccess || rebuild.isSuccess) && buildInFlight && (
            <p role="status" className="text-sm">
              {t("settings.profile.started")}
            </p>
          )}
        </div>
      )}
      <ConfirmDeleteDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t("settings.profile.confirmTitle")}
        description={t(
          (
            confirming === "profile"
              ? systemData?.items.some((item) => item.providerId === selected?.providerId)
              : profile.data?.profile?.kind === "SYSTEM_BUILTIN"
          )
            ? "settings.profile.confirmBuiltinDescription"
            : "settings.profile.confirmDescription",
        )}
        confirmToken="RUN"
        typePrompt={t("settings.profile.confirmPrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.profile.confirmAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={pending}
        onConfirm={() => {
          if (confirming === "profile" && selected)
            setProfile.mutate({
              kbId: kb.id,
              providerId: selected.providerId,
              revision: selected.revision,
              idempotencyKey: attempt.key,
              confirm: "RUN",
            });
          else if (confirming === "rebuild")
            rebuild.mutate({ kbId: kb.id, idempotencyKey: attempt.key, confirm: "RUN" });
        }}
      />
    </section>
  );
}
