import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { SelectItem } from "@knowledge-base/ui/components/select";
import { toast } from "@knowledge-base/ui/components/sileo";
import { SelectField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import {
  type MutationObserverOptions,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import type * as React from "react";
import { useReducer } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { AclPicker } from "@/components/kb/acl-picker";
import type { GrantEditTarget } from "@/components/kb/grant-edit-sheet";
import { presetFor } from "@/components/kb/tool-group-picker";
import { LoadMore } from "@/components/load-more";
import { SecretReveal } from "@/components/secret-reveal";
import { StatusPill } from "@/components/status-pill";
import {
  emptySelection,
  isConsentRejection,
  selectionIssues,
  selectionReducer,
  toGrantSelection,
  useLiveKbOptions,
} from "@/hooks/use-mcp-consent";
import { orpc } from "@/utils/orpc";

type Client = AppRouterClient;
export type TokenRow = Awaited<ReturnType<Client["mcpTokens"]["listMine"]>>["items"][number];
export type GrantRow = Awaited<ReturnType<Client["mcpGrants"]["listMine"]>>["items"][number];

/** Query-key root for the user's PAT list; invalidated (never written) after a mint. */
export const PAT_LIST_QUERY_ROOT: readonly unknown[] = orpc.mcpTokens.key();

const DAY_MS = 86_400_000;
const MAX_TTL_DAYS = 365;
const EXPIRY_PRESETS = ["30", "90", "365"] as const;
const EXPIRY_CHOICES = [...EXPIRY_PRESETS, "custom", "none"] as const;
export type PatExpiryChoice = (typeof EXPIRY_CHOICES)[number];
const DEFAULT_EXPIRY: PatExpiryChoice = "90";

function localDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

/**
 * The create dialog's expiry choice as the mint's `expiresAt`: a preset
 * is now+days, a custom date is local midnight of that day (tomorrow up to the
 * 365-day cap), and "none" is an explicit `null` — a token that never expires.
 */
export function patExpiresAtFromChoice(
  choice: PatExpiryChoice,
  customDate: string,
  now: Date,
): { ok: true; expiresAt: Date | null } | { ok: false } {
  if (choice === "none") return { ok: true, expiresAt: null };
  if (choice !== "custom")
    return { ok: true, expiresAt: new Date(now.getTime() + Number(choice) * DAY_MS) };
  const date = localDate(customDate);
  if (!date || date <= now || date.getTime() > now.getTime() + MAX_TTL_DAYS * DAY_MS)
    return { ok: false };
  return { ok: true, expiresAt: date };
}

/**
 * Mint mutation hygiene: the raw secret must live only in the mutation result
 * that the open dialog renders. Closing detaches its observer; `gcTime: 0`
 * collects a settled mutation immediately and an abandoned pending mutation
 * after it settles. Refetch the list instead of caching the mint response.
 */
export function withPatSecretHygiene<TData, TError, TVariables>(
  queryClient: QueryClient,
  options: MutationObserverOptions<TData, TError, TVariables>,
): MutationObserverOptions<TData, TError, TVariables> {
  return {
    ...options,
    gcTime: 0,
    onSuccess: async (...args) => {
      await options.onSuccess?.(...args);
      await queryClient.invalidateQueries({ queryKey: [...PAT_LIST_QUERY_ROOT] });
    },
    // The mint may have committed even if its reply was lost. Never replay a secret.
    onError: async (...args) => {
      await options.onError?.(...args);
      await queryClient.invalidateQueries({ queryKey: [...PAT_LIST_QUERY_ROOT] });
    },
  };
}

/** The Edit access Sheet's view of a PAT, through its token row. */
export function editTargetFromToken(token: TokenRow): GrantEditTarget {
  return {
    grantId: token.grantId,
    kind: "PAT",
    name: token.name,
    scopes: token.scopes,
    toolGroups: token.toolGroups,
    allowCreate: token.allowCreate,
    createdKbBits: token.createdKbBits,
    neverExpires: token.expiresAt === null,
    activeElevations: token.elevations.length,
  };
}

/** The Edit access Sheet's view of a connected app. */
export function editTargetFromGrant(grant: GrantRow): GrantEditTarget {
  return {
    grantId: grant.id,
    kind: grant.kind,
    name: grant.clientName ?? grant.clientId ?? grant.id,
    scopes: grant.scopes,
    toolGroups: grant.toolGroups,
    allowCreate: grant.allowCreate,
    createdKbBits: grant.createdKbBits,
    neverExpires: false,
    activeElevations: grant.elevations.length,
  };
}

/** Only explicit domain refusals guarantee no mint; internal/transport errors are unknown. */
export function isPatMintRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return isConsentRejection(error) || code === "CONFLICT" || code === "TOO_MANY_REQUESTS";
}

type CredentialListProps = {
  lang: string;
  tokens: readonly TokenRow[];
  grants: readonly GrantRow[];
  onCreate: () => void;
  onEditToken: (token: TokenRow) => void;
  onEditGrant: (grant: GrantRow) => void;
  onRevokeToken: (token: TokenRow) => void;
  onRevokeGrant: (grant: GrantRow) => void;
  tokensFooter?: React.ReactNode;
  grantsFooter?: React.ReactNode;
};

/**
 * The signed-in user's own PATs and OAuth app grants. Rows never carry a
 * secret; only live rows offer edit and revoke. PAT generations are edited and
 * revoked through their token row, so the grant list shows connected apps only.
 */
export function CredentialList({
  lang,
  tokens,
  grants,
  onCreate,
  onEditToken,
  onEditGrant,
  onRevokeToken,
  onRevokeGrant,
  tokensFooter,
  grantsFooter,
}: CredentialListProps) {
  const { t } = useTranslation("settings");
  const date = (value: Date | string) =>
    new Date(value).toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
  const apps = grants.filter((grant) => grant.kind !== "PAT");

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="credentials-tokens">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="credentials-tokens" className="text-lg font-semibold">
            {t("credentials.tokensTitle")}
          </h2>
          <Button className="min-h-[44px]" onClick={onCreate}>
            <Plus className="size-4" />
            {t("credentials.create")}
          </Button>
        </div>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("credentials.noTokens")}</p>
        ) : (
          <ul className="grid min-w-0 gap-3">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex min-w-0 flex-wrap items-start gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <KeyRound className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{token.name}</span>
                    <TokenStatePill revokedAt={token.revokedAt} expiresAt={token.expiresAt} />
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {token.lookupPrefix}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {token.scopes.join(" ")} ·{" "}
                    {token.revokedAt
                      ? t("credentials.revoked")
                      : token.expiresAt === null
                        ? t("credentials.neverExpires")
                        : t("credentials.expires", { date: date(token.expiresAt) })}
                  </p>
                  <ToolGroupsSummary groups={token.toolGroups} />
                  <WidenedOn date={token.widenedAt} format={date} />
                  {!token.revokedAt && !expired(token.expiresAt) && (
                    <TemporaryAccess elevations={token.elevations} lang={lang} />
                  )}
                </div>
                {!token.revokedAt && !expired(token.expiresAt) && (
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    aria-label={t("credentials.editAccessFor", { name: token.name })}
                    onClick={() => onEditToken(token)}
                  >
                    {t("credentials.editAccess")}
                  </Button>
                )}
                {!token.revokedAt && (
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    aria-label={t("credentials.revokeFor", { name: token.name })}
                    onClick={() => onRevokeToken(token)}
                  >
                    {t("credentials.revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {tokensFooter}
      </section>

      <section className="space-y-3" aria-labelledby="credentials-apps">
        <h2 id="credentials-apps" className="text-lg font-semibold">
          {t("credentials.appsTitle")}
        </h2>
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("credentials.noApps")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {apps.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-start gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate font-medium">
                    {grant.clientName ?? grant.clientId ?? grant.id}
                  </p>
                  {grant.clientName && (
                    // The registered name is chosen by the app itself; the id is what it is.
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {grant.clientId}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {grant.scopes.join(" ")} ·{" "}
                    {grant.revokedAt
                      ? t("credentials.revoked")
                      : t("credentials.approved", { date: date(grant.createdAt) })}
                  </p>
                  <ToolGroupsSummary groups={grant.toolGroups} />
                  <WidenedOn date={grant.widenedAt} format={date} />
                  {!grant.revokedAt && (
                    <TemporaryAccess elevations={grant.elevations} lang={lang} />
                  )}
                  <GrantPermissions grant={grant} />
                  {grant.allowCreate && (
                    <p className="text-xs">
                      {t("credentials.grantCreates", {
                        bits: grant.createdKbBits
                          .map((bit) => t(`credentials.picker.bits.${bit}.label`))
                          .join(", "),
                      })}
                    </p>
                  )}
                </div>
                {!grant.revokedAt && (
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    aria-label={t("credentials.editAccessFor", {
                      name: grant.clientName ?? grant.clientId ?? grant.id,
                    })}
                    onClick={() => onEditGrant(grant)}
                  >
                    {t("credentials.editAccess")}
                  </Button>
                )}
                {!grant.revokedAt && (
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    aria-label={t("credentials.revokeFor", {
                      name: grant.clientName ?? grant.clientId ?? grant.id,
                    })}
                    onClick={() => onRevokeGrant(grant)}
                  >
                    {t("credentials.revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {grantsFooter}
      </section>
    </div>
  );
}

const expired = (expiresAt: Date | string | null) =>
  expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();

/** Active / Expired / Revoked, next to the token name (the text still says the dates). */
function TokenStatePill({
  revokedAt,
  expiresAt,
}: {
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
}) {
  const { t } = useTranslation("settings");
  if (revokedAt) return <StatusPill tone="muted">{t("credentials.state.revoked")}</StatusPill>;
  if (expired(expiresAt))
    return <StatusPill tone="busy">{t("credentials.state.expired")}</StatusPill>;
  return <StatusPill tone="good">{t("credentials.state.active")}</StatusPill>;
}

/** Shown after an in-place widening, since the old credential gained access. */
function WidenedOn({
  date,
  format,
}: {
  date: Date | string | null;
  format: (value: Date | string) => string;
}) {
  const { t } = useTranslation("settings");
  return date ? (
    <p className="text-xs text-muted-foreground">
      {t("credentials.widenedOn", { date: format(date) })}
    </p>
  ) : null;
}

type ElevationRow = TokenRow["elevations"][number];

/** Remaining time in its largest whole unit (at least one minute). */
export function remainingParts(seconds: number): {
  unit: "days" | "hours" | "minutes";
  count: number;
} {
  if (seconds >= 86_400) return { unit: "days", count: Math.floor(seconds / 86_400) };
  if (seconds >= 3600) return { unit: "hours", count: Math.floor(seconds / 3600) };
  return { unit: "minutes", count: Math.max(1, Math.ceil(seconds / 60)) };
}

/**
 * Temporary access in force on a connection, with what it adds, its remaining
 * time (read on the server clock when the list loaded) and an End now action
 * that removes it immediately.
 */
function TemporaryAccess({
  elevations,
  lang,
}: {
  elevations: readonly ElevationRow[];
  lang: string;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const end = useMutation(
    orpc.mcpGrants.endElevationMine.mutationOptions({
      onSuccess: () => toast.success(t("credentials.temporary.ended")),
      onError: () => toast.error(t("credentials.temporary.endError")),
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.key() }),
        ]),
    }),
  );
  if (elevations.length === 0) return null;
  return (
    <section className="min-w-0 space-y-2" aria-label={t("credentials.temporary.title")}>
      <h3 className="text-xs font-medium">{t("credentials.temporary.title")}</h3>
      <ul className="space-y-2">
        {elevations.map((elevation) => {
          const remaining = remainingParts(elevation.remainingSeconds);
          const adds = [
            ...elevation.toolGroups.map((group) =>
              t("credentials.edit.changeGroup", {
                group: t(`credentials.picker.groups.${group}.label`),
              }),
            ),
            ...(elevation.kbCount > 0
              ? [t("credentials.temporary.kbs", { count: elevation.kbCount })]
              : []),
            ...(elevation.allowCreate ? [t("credentials.edit.changeCreate")] : []),
          ];
          return (
            <li
              key={elevation.id}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-dashed p-2"
            >
              <div className="min-w-0 flex-1 space-y-0.5 text-xs">
                <p className="break-words">{adds.join(", ")}</p>
                <p className="text-muted-foreground">
                  {t(`credentials.temporary.endsIn.${remaining.unit}`, {
                    count: remaining.count,
                    date: new Date(elevation.expiresAt).toLocaleString(lang, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }),
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                disabled={end.isPending}
                onClick={() => end.mutate({ id: elevation.id })}
              >
                {end.isPending && end.variables?.id === elevation.id
                  ? t("credentials.temporary.ending")
                  : t("credentials.temporary.endNow")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The connection's preset, or its groups when they match no preset. */
function ToolGroupsSummary({ groups }: { groups: readonly string[] }) {
  const { t } = useTranslation("settings");
  const known = MCP_TOOL_GROUPS.filter((group) => groups.includes(group));
  const preset = presetFor(known);
  return (
    <p className="text-xs">
      {t("credentials.toolGroupsSummary", {
        groups:
          preset === "custom"
            ? known.map((group) => t(`credentials.picker.groups.${group}.label`)).join(", ")
            : t(`credentials.picker.presets.${preset}.label`),
      })}
    </p>
  );
}

/** First-page preview plus explicit bounded inspection of creator-added permissions. */
function GrantPermissions({ grant }: { grant: GrantRow }) {
  const { t } = useTranslation(["settings", "common"]);
  const options = orpc.mcpGrants.listAclMine.infiniteOptions({
    input: (cursor: string | null) => ({ grantId: grant.id, limit: 50, cursor }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    initialData: {
      pages: [{ items: grant.acl, nextCursor: grant.aclNextCursor }],
      pageParams: [null],
    },
    // The outer list already fetched the preview. Fetch only on inspection or invalidation.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  // The authority operation identifies this inspection, not the grant's
  // generation. Every outer refresh starts a fresh tail, including replacements
  // with the same preview/cardinality. Old in-flight pages own a different key.
  const permissions = useInfiniteQuery({
    ...options,
    queryKey: [...options.queryKey, grant.aclSnapshot],
  });
  const { data, isError, hasNextPage, isFetchingNextPage } = permissions;
  const entries = data?.pages.flatMap((page) => page.items) ?? grant.acl;
  return (
    <>
      {entries.length === 0 ? (
        <p className="text-xs">{t("settings:credentials.grantNoKbs")}</p>
      ) : (
        <ul className="space-y-0.5 text-xs">
          {entries.map((entry) => (
            <li key={entry.kbId} className="min-w-0 break-words">
              {entry.name ? (
                <span>{entry.name}</span>
              ) : (
                <span className="font-mono">{entry.kbId}</span>
              )}
              :{" "}
              {entry.bits
                .map((bit) => t(`settings:credentials.picker.bits.${bit}.label`))
                .join(", ")}
            </li>
          ))}
        </ul>
      )}
      {hasNextPage && <p className="text-xs">{t("settings:credentials.morePermissions")}</p>}
      {isError && (
        <InlineRetry
          message={t("settings:credentials.listLoadError")}
          onRetry={() => permissions.fetchNextPage()}
        />
      )}
      <LoadMore
        onLoadMore={() => permissions.fetchNextPage()}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
      />
    </>
  );
}

/** One-time secret display. Rendered only inside the open create dialog. */
export function PatSecretReveal({ secret }: { secret: string }) {
  const { t } = useTranslation("settings");
  return (
    <SecretReveal
      value={secret}
      title={t("credentials.secretOnce")}
      copyLabel={t("credentials.copySecret")}
    />
  );
}

/**
 * Create → Dialog. Uses the shared picker with nothing preselected. Closing
 * resets and unmounts this form. Reopening owns a new observer/draft, so late
 * responses cannot reveal the abandoned secret in the new dialog.
 */
export function PatCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return open ? <PatCreateForm onOpenChange={onOpenChange} /> : null;
}

function PatCreateForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const { query: kbQuery, live } = useLiveKbOptions();
  const [selection, dispatch] = useReducer(selectionReducer, undefined, emptySelection);
  const grant = toGrantSelection(selection, live);
  const issues = selectionIssues(grant);
  const mint = useMutation(
    withPatSecretHygiene(queryClient, orpc.mcpTokens.create.mutationOptions()),
  );
  const form = useForm({
    defaultValues: { name: "", expiry: DEFAULT_EXPIRY as PatExpiryChoice, customDate: "" },
    validators: {
      onSubmit: z
        .object({
          name: z.string().trim().min(1).max(100),
          expiry: z.enum(EXPIRY_CHOICES),
          customDate: z.string(),
        })
        .refine((value) => patExpiresAtFromChoice(value.expiry, value.customDate, new Date()).ok, {
          path: ["customDate"],
          message: t("settings:credentials.expiryInvalid"),
        }),
    },
    onSubmit: async ({ value }) => {
      if (issues.length > 0 || mint.isPending || (mint.isError && !isPatMintRejection(mint.error)))
        return;
      const expiry = patExpiresAtFromChoice(value.expiry, value.customDate, new Date());
      if (!expiry.ok) return;
      mint.mutate({
        name: value.name.trim(),
        scopes: grant.scopes.filter((s) => s !== "offline_access"),
        toolGroups: grant.toolGroups,
        acl: grant.acl,
        allowCreate: grant.allowCreate,
        createdKbBits: grant.createdKbBits,
        expiresAt: expiry.expiresAt,
      });
    },
  });

  const close = (next: boolean) => {
    if (next) return onOpenChange(true);
    mint.reset();
    form.reset();
    dispatch({ type: "reset" });
    onOpenChange(false);
  };

  const minted = mint.data;
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:credentials.createTitle")}</DialogTitle>
          <DialogDescription>{t("settings:credentials.createDescription")}</DialogDescription>
        </DialogHeader>
        {minted ? (
          <>
            <PatSecretReveal secret={minted.secret} />
            <DialogFooter>
              <Button className="min-h-[44px]" onClick={() => close(false)}>
                {t("settings:credentials.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="min-w-0 space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <form.Field name="name">
              {(field) => (
                <TextField
                  field={field}
                  label={t("settings:credentials.nameLabel")}
                  autoComplete="off"
                  inputMode="text"
                  maxLength={100}
                />
              )}
            </form.Field>
            <form.Field name="expiry">
              {(field) => (
                <SelectField
                  field={field}
                  label={t("settings:credentials.expiryLabel")}
                  description={t("settings:credentials.expiryHelp", { max: MAX_TTL_DAYS })}
                  // The value is a day count ("90"); show it with its unit (R2-27).
                  valueLabel={
                    field.state.value === "custom"
                      ? t("settings:credentials.expiryCustom")
                      : field.state.value === "none"
                        ? t("settings:credentials.expiryNone")
                        : t("settings:credentials.expiryDays", {
                            count: Number(field.state.value),
                          })
                  }
                >
                  {EXPIRY_PRESETS.map((days) => (
                    <SelectItem key={days} value={days} className="min-h-[44px]">
                      {t("settings:credentials.expiryDays", { count: Number(days) })}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom" className="min-h-[44px]">
                    {t("settings:credentials.expiryCustom")}
                  </SelectItem>
                  <SelectItem value="none" className="min-h-[44px]">
                    {t("settings:credentials.expiryNone")}
                  </SelectItem>
                </SelectField>
              )}
            </form.Field>
            <form.Subscribe selector={(state) => state.values.expiry}>
              {(expiry) =>
                expiry === "custom" ? (
                  <form.Field name="customDate">
                    {(field) => (
                      <TextField
                        field={field}
                        type="date"
                        label={t("settings:credentials.expiryDateLabel")}
                        autoComplete="off"
                        inputMode="numeric"
                      />
                    )}
                  </form.Field>
                ) : expiry === "none" ? (
                  <p role="status" className="text-sm text-destructive">
                    {t("settings:credentials.noExpiryWarning")}
                  </p>
                ) : null
              }
            </form.Subscribe>
            {kbQuery.isError ? (
              <InlineRetry
                message={t("settings:credentials.kbsLoadError")}
                onRetry={() => kbQuery.refetch()}
              />
            ) : (
              <AclPicker
                live={live}
                selection={selection}
                onChange={dispatch}
                scopeMode="select"
                writeScopeSelected={grant.scopes.includes("mcp:write")}
                offerSealed
                disabled={mint.isPending || kbQuery.isPending}
              />
            )}
            {kbQuery.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                disabled={kbQuery.isFetchingNextPage}
                onClick={() => kbQuery.fetchNextPage()}
              >
                {t("common:actions.loadMore")}
              </Button>
            )}
            {issues.map((issue) => (
              <p key={issue} className="text-sm text-muted-foreground">
                {t(`settings:credentials.picker.issues.${issue}`)}
              </p>
            ))}
            {mint.isError && (
              <p role="alert" className="text-sm text-destructive">
                {isPatMintRejection(mint.error)
                  ? t("settings:credentials.createError")
                  : t("settings:credentials.createUncertain", { name: mint.variables?.name ?? "" })}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                onClick={() => close(false)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-[44px]"
                disabled={
                  mint.isPending ||
                  issues.length > 0 ||
                  (mint.isError && !isPatMintRejection(mint.error))
                }
              >
                {mint.isPending
                  ? t("settings:credentials.creating")
                  : t("settings:credentials.createSubmit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
