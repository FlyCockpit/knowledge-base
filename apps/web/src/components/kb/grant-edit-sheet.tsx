import { Button } from "@knowledge-base/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { AclPicker } from "@/components/kb/acl-picker";
import { LoadMore } from "@/components/load-more";
import { SegmentedControl } from "@/components/segmented-control";
import {
  type CredentialSelection,
  isConsentRejection,
  KB_BITS,
  type KbBit,
  type LiveKbOption,
  type McpScope,
  selectionIssues,
  selectionReducer,
  useLiveKbOptions,
} from "@/hooks/use-mcp-consent";
import { useMountEffect } from "@/hooks/use-mount-effect";
import {
  type EditDuration,
  ELEVATION_DURATIONS,
  type GrantCeiling,
  type GrantEditChanges,
  type GrantEditPlan,
  grantEditPlan,
  MAX_ACTIVE_ELEVATIONS,
  planNarrows,
  selectionFromGrant,
  temporaryInput,
  temporaryIssue,
} from "@/lib/mcp-grant-edit";
import { orpc } from "@/utils/orpc";

/** One connection to edit: a PAT (through its token row) or a connected app. */
export type GrantEditTarget = Omit<GrantCeiling, "acl"> & {
  grantId: string;
  kind: "PAT" | "OAUTH";
  name: string;
  /** A PAT with no expiry; widening it permanently shows a warning. */
  neverExpires: boolean;
  /** Temporary access currently in force on this connection. */
  activeElevations: number;
};

/**
 * Edit → Sheet: widen or narrow an existing connection in place
 * (`mcpGrants.updateMine`), permanently or as temporary access (1 hour, 1 day
 * or 7 days) that only adds and lapses on its own. Reuses the credential
 * picker; additions need an explicit confirmation that lists exactly what is
 * added. The server re-validates every added bit against live rights and
 * rejects, never clips.
 */
export function GrantEditSheet({
  target,
  onOpenChange,
}: {
  target: GrantEditTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return target ? (
    <GrantEditSession key={target.grantId} target={target} onOpenChange={onOpenChange} />
  ) : null;
}

function GrantEditSession({
  target,
  onOpenChange,
}: {
  target: GrantEditTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  // The complete stored ACL is the baseline; editing waits until every page is loaded,
  // so a KB beyond the first page is never mistaken for an addition.
  const acl = useInfiniteQuery(
    orpc.mcpGrants.listAclMine.infiniteOptions({
      input: (cursor: string | null) => ({ grantId: target.grantId, limit: 50, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
      gcTime: 0,
    }),
  );
  const { data, isPending, isError, hasNextPage, isFetchingNextPage } = acl;
  const complete = !isPending && !isError && !hasNextPage;
  // The first complete load is frozen as the editing snapshot. Later refetches
  // (e.g. a KB the agent creates meanwhile) never change what the draft is
  // compared against, and never unmount the draft.
  const [snapshot, setSnapshot] = useState<CredentialSelection | null>(null);
  if (complete && snapshot === null)
    setSnapshot(selectionFromGrant({ ...target, acl: data.pages.flatMap((page) => page.items) }));
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{t("settings:credentials.edit.title", { name: target.name })}</SheetTitle>
          <SheetDescription>{t("settings:credentials.edit.description")}</SheetDescription>
        </SheetHeader>
        <div className="min-w-0 space-y-4 px-4 pb-4">
          {snapshot ? (
            <GrantEditForm target={target} snapshot={snapshot} onDone={() => onOpenChange(false)} />
          ) : isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
            </div>
          ) : isError ? (
            <InlineRetry
              message={t("settings:credentials.edit.loadError")}
              onRetry={() => acl.refetch()}
            />
          ) : (
            <>
              <p className="text-sm">{t("settings:credentials.edit.loadAll")}</p>
              <LoadMore
                onLoadMore={() => acl.fetchNextPage()}
                hasNextPage={hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GrantEditForm({
  target,
  snapshot,
  onDone,
}: {
  target: GrantEditTarget;
  snapshot: CredentialSelection;
  onDone: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const { query: kbQuery, live } = useLiveKbOptions();
  const [selection, dispatch] = useReducer(selectionReducer, snapshot);
  // Only KBs the user toggles are ever patched.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<{
    plan: GrantEditPlan;
    duration: EditDuration;
  } | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const [duration, setDuration] = useState<EditDuration>("permanent");
  const temporary = duration !== "permanent";
  const limitReached = target.activeElevations >= MAX_ACTIVE_ELEVATIONS;
  const oauth = target.kind === "OAUTH";
  // Temporary access never changes scopes: they stay as stored.
  const fixedScopes = oauth || temporary;
  const plan = grantEditPlan(snapshot, selection, { scopesEditable: !fixedScopes, touched });
  const { options, removalOnly } = storedKbOptions(snapshot, live);
  const scopes = (
    oauth ? target.scopes : temporary ? snapshot.scopes : (plan.input.scopes ?? snapshot.scopes)
  ).filter(
    (scope): scope is McpScope =>
      scope === "mcp:read" || scope === "mcp:write" || scope === "offline_access",
  );
  const issues = selectionIssues({
    scopes,
    toolGroups: [...selection.toolGroups],
    acl: [],
    allowCreate: selection.allowCreate,
    createdKbBits: [...selection.createdKbBits],
  });
  const temporaryProblem = temporary
    ? temporaryIssue(plan, {
        writeScope: scopes.includes("mcp:write"),
        activeElevations: target.activeElevations,
      })
    : null;
  const update = useMutation(
    orpc.mcpGrants.updateMine.mutationOptions({
      onSuccess: async (_result, variables) => {
        toast.success(
          t(
            variables.duration
              ? "settings:credentials.edit.savedTemporary"
              : "settings:credentials.edit.saved",
          ),
        );
        onDone();
      },
      // Committed or not, the lists are refetched; the server state is the only truth.
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.key() }),
        ]),
    }),
  );
  const save = (edit: GrantEditPlan, length: EditDuration) =>
    update.mutate({
      id: target.grantId,
      ...(length === "permanent" ? edit.input : temporaryInput(edit, length)),
    });
  // Temporary access always adds, so it is always confirmed. A permanent
  // narrowing is confirmed too while temporary access is active: it ends it.
  const needsConfirm =
    !plan.empty && (plan.widens || temporary || (planNarrows(plan) && target.activeElevations > 0));
  const form = useForm({
    defaultValues: {},
    onSubmit: () => {
      if (issues.length > 0 || temporaryProblem || update.isPending) return;
      if (plan.empty) return setUnchanged(true);
      if (needsConfirm) return setConfirming({ plan, duration });
      save(plan, duration);
    },
  });
  const names = new Map(live.map((kb) => [kb.kbId, kb.name]));

  if (confirming) {
    return (
      <div className="min-w-0 space-y-4">
        <ConfirmStepHeading
          step={t("settings:credentials.edit.confirmStep")}
          title={t(
            confirming.plan.widens
              ? "settings:credentials.edit.confirmTitle"
              : "settings:credentials.edit.confirmChangesTitle",
          )}
        />
        {confirming.plan.widens && (
          <p className="text-sm text-muted-foreground">
            {t("settings:credentials.edit.confirmDescription")}
          </p>
        )}
        <ChangeList direction="added" changes={confirming.plan.added} names={names} />
        <ChangeList direction="removed" changes={confirming.plan.removed} names={names} />
        {confirming.duration === "permanent" ? (
          <>
            {planNarrows(confirming.plan) && target.activeElevations > 0 && (
              <p role="status" className="text-sm text-destructive">
                {t("settings:credentials.edit.endsTemporary")}
              </p>
            )}
            {confirming.plan.widens && target.neverExpires && (
              <p role="status" className="text-sm text-destructive">
                {t("settings:credentials.edit.noExpiryWarning")}
              </p>
            )}
          </>
        ) : (
          <>
            <p role="status" className="text-sm">
              {t("settings:credentials.edit.temporaryConfirm", {
                duration: t(`settings:credentials.edit.durations.${confirming.duration}`),
              })}
            </p>
            {(confirming.plan.added.allowCreate ||
              confirming.plan.added.createdKbBits.length > 0) && (
              <p className="text-sm text-muted-foreground">
                {t("settings:credentials.edit.temporaryCreatedKbs")}
              </p>
            )}
          </>
        )}
        <UpdateError error={update.error} />
        <SheetFooter className="px-0">
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            disabled={update.isPending}
            onClick={() => setConfirming(null)}
          >
            {t("settings:credentials.edit.back")}
          </Button>
          <Button
            type="button"
            className="min-h-[44px]"
            disabled={update.isPending}
            onClick={() => save(confirming.plan, confirming.duration)}
          >
            {update.isPending
              ? t("settings:credentials.edit.saving")
              : confirming.plan.widens || confirming.duration !== "permanent"
                ? t("settings:credentials.edit.confirmSubmit")
                : t("settings:credentials.edit.save")}
          </Button>
        </SheetFooter>
      </div>
    );
  }

  return (
    <form
      className="min-w-0 space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">
          {t("settings:credentials.edit.durationLegend")}
        </legend>
        {limitReached ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("settings:credentials.edit.temporaryLimit", { max: MAX_ACTIVE_ELEVATIONS })}
          </p>
        ) : (
          <>
            <SegmentedControl<EditDuration>
              value={duration}
              ariaLabel={t("settings:credentials.edit.durationLegend")}
              items={(["permanent", ...ELEVATION_DURATIONS] as const).map((value) => ({
                value,
                label: t(`settings:credentials.edit.durations.${value}`),
              }))}
              onChange={(next) => {
                if (update.isPending) return;
                setUnchanged(false);
                setDuration(next);
              }}
            />
            <p className="text-sm text-muted-foreground">
              {t(
                temporary
                  ? "settings:credentials.edit.temporaryHint"
                  : "settings:credentials.edit.permanentHint",
              )}
            </p>
          </>
        )}
      </fieldset>
      {oauth && (
        <p className="text-sm text-muted-foreground">
          {t("settings:credentials.edit.oauthScopes")}
        </p>
      )}
      {kbQuery.isError ? (
        <InlineRetry
          message={t("settings:credentials.kbsLoadError")}
          onRetry={() => kbQuery.refetch()}
        />
      ) : (
        <AclPicker
          live={options}
          selection={selection}
          removalOnly={removalOnly}
          onChange={(action) => {
            setUnchanged(false);
            if (action.type === "toggleBit")
              setTouched((previous) => new Set(previous).add(action.kbId));
            dispatch(action);
          }}
          scopeMode={fixedScopes ? "fixed" : "select"}
          fixedScopes={oauth ? target.scopes : snapshot.scopes}
          writeScopeSelected={scopes.includes("mcp:write")}
          offerSealed={!oauth}
          disabled={update.isPending || kbQuery.isPending}
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
      {temporaryProblem && (
        <p role="status" className="text-sm text-destructive">
          {t(`settings:credentials.edit.temporaryIssues.${temporaryProblem}`, {
            max: MAX_ACTIVE_ELEVATIONS,
          })}
        </p>
      )}
      {unchanged && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("settings:credentials.edit.unchanged")}
        </p>
      )}
      <UpdateError error={update.error} />
      <SheetFooter className="px-0">
        <Button
          type="submit"
          className="min-h-[44px]"
          disabled={update.isPending || issues.length > 0 || temporaryProblem !== null}
        >
          {update.isPending
            ? t("settings:credentials.edit.saving")
            : needsConfirm
              ? t("settings:credentials.edit.review")
              : t("settings:credentials.edit.save")}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * The second step replaces the form in place, so say it is a step (nothing is
 * saved yet) and move focus to it: the user is never left thinking the first
 * button already saved.
 */
function ConfirmStepHeading({ step, title }: { step: string; title: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useMountEffect(() => heading.current?.focus());
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{step}</p>
      <h3 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
        {title}
      </h3>
    </div>
  );
}

/**
 * Picker options for editing: every live KB, plus each stored entry. Stored
 * bits the user no longer holds live (a downgraded or revoked share) are shown
 * so they can be removed, but are removal-only; additions stay live-only.
 */
export function storedKbOptions(
  snapshot: CredentialSelection,
  live: readonly LiveKbOption[],
): { options: LiveKbOption[]; removalOnly: Record<string, KbBit[]> } {
  const liveById = new Map(live.map((kb) => [kb.kbId, kb]));
  const options: LiveKbOption[] = [
    ...live.map((kb) => {
      const stored = snapshot.acl[kb.kbId] ?? [];
      return {
        ...kb,
        bits: KB_BITS.filter((bit) => kb.bits.includes(bit) || stored.includes(bit)),
      };
    }),
    ...Object.keys(snapshot.acl)
      .filter((kbId) => !liveById.has(kbId))
      .sort()
      .map((kbId) => ({ kbId, name: kbId, bits: [...(snapshot.acl[kbId] ?? [])] })),
  ];
  const removalOnly: Record<string, KbBit[]> = {};
  for (const [kbId, bits] of Object.entries(snapshot.acl)) {
    const held = liveById.get(kbId)?.bits ?? [];
    const stale = bits.filter((bit) => !held.includes(bit));
    if (stale.length) removalOnly[kbId] = stale;
  }
  return { options, removalOnly };
}

function UpdateError({ error }: { error: unknown }) {
  const { t } = useTranslation("settings");
  if (!error) return null;
  const code = (error as { code?: unknown }).code;
  return (
    <p role="alert" className="text-sm text-destructive">
      {code === "TOO_MANY_REQUESTS"
        ? t("credentials.edit.rateLimited")
        : isConsentRejection(error) || code === "CONFLICT"
          ? t("credentials.edit.rejected")
          : t("credentials.edit.error")}
    </p>
  );
}

/** Exactly what an edit adds (or removes), in words; KBs by name when known. */
export function ChangeList({
  direction,
  changes,
  names,
}: {
  direction: "added" | "removed";
  changes: GrantEditChanges;
  names: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation("settings");
  const bits = (list: readonly string[]) =>
    list.map((bit) => t(`credentials.picker.bits.${bit}.label`)).join(", ");
  const items = [
    ...changes.scopes.map((scope) =>
      t(`credentials.picker.scopes.${scope === "mcp:write" ? "write" : "read"}`),
    ),
    ...changes.toolGroups.map((group) =>
      t("credentials.edit.changeGroup", {
        group: t(`credentials.picker.groups.${group}.label`),
      }),
    ),
    ...changes.kbs.map((kb) =>
      t("credentials.edit.changeKb", { name: names.get(kb.kbId) ?? kb.kbId, bits: bits(kb.bits) }),
    ),
    ...(changes.cap
      ? [
          t("credentials.edit.changeCap", {
            bits: bits(changes.cap.bits),
            count: changes.cap.count,
          }),
        ]
      : []),
    ...(changes.allowCreate ? [t("credentials.edit.changeCreate")] : []),
    ...(changes.createdKbBits.length
      ? [t("credentials.edit.changeCreatedBits", { bits: bits(changes.createdKbBits) })]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <section className="min-w-0 space-y-1">
      <h4 className="text-sm font-medium">{t(`credentials.edit.${direction}`)}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-sm break-words">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
