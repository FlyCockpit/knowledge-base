import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import type { McpAuthoringMode } from "@knowledge-base/auth/mcp-authoring-mode";
import {
  MCP_TOOL_GROUPS,
  MCP_TOOL_PRESETS,
  type McpToolGroup,
  type McpToolPreset,
} from "@knowledge-base/auth/mcp-tool-groups";
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
import { SelectField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { ApiKeyNextSteps } from "@/components/kb/api-key-next-steps";
import { AuthoringModePicker } from "@/components/kb/authoring-mode-picker";
import { CheckRow } from "@/components/kb/check-row";
import { AdvancedSection, CreateFooter } from "@/components/kb/credential-dialog-parts";
import {
  EXPIRY_CHOICES,
  EXPIRY_PRESETS,
  isPatMintRejection,
  MAX_TTL_DAYS,
  type PatExpiryChoice,
  patExpiresAtFromChoice,
  withPatSecretHygiene,
} from "@/components/kb/credential-list";
import { RadioCards } from "@/components/kb/radio-cards";
import { presetFor, ToolGroupPicker } from "@/components/kb/tool-group-picker";
import { SecretReveal } from "@/components/secret-reveal";
import {
  expandKbBits,
  KB_BITS,
  type KbBit,
  type LiveKbOption,
  type SelectionAction,
  useLiveKbOptions,
} from "@/hooks/use-mcp-consent";
import { groupsWrite } from "@/lib/mcp-connect";
import { isBrowserOffline } from "@/lib/network-failure";
import { orpc } from "@/utils/orpc";

type ApiKeyMintInput = Parameters<AppRouterClient["apiKeys"]["create"]>[0];

const API_KEY_REACHES = ["all", "selected", "created"] as const;
type ApiKeyReach = (typeof API_KEY_REACHES)[number];
/** A key's expiry picker starts on a year; "none" (never expires) is an explicit choice. */
export const API_KEY_DEFAULT_EXPIRY: PatExpiryChoice = "365";

/** Query-key root of the user's API key list; invalidated (never written) after a mint. */
export const API_KEY_LIST_QUERY_ROOT: readonly unknown[] = orpc.apiKeys.key();

/**
 * Everything the create dialog chooses besides the name and expiry. Nothing
 * is preselected: no reach, no permission, no capability. Minted tokens start
 * on the Read tool group, read-only, without sealed values or KB creation, and
 * independent of the key (they outlive it).
 */
export type ApiKeyDraft = {
  reach: ApiKeyReach | null;
  kbIds: readonly string[];
  /** The ticked permissions; the ceiling is their expansion (manage implies all). */
  bits: readonly KbBit[];
  allowCreate: boolean;
  allowDelete: boolean;
  allowMintChildren: boolean;
  childToolGroups: readonly McpToolGroup[];
  /** Required when the child tool groups change data (then minted tokens may write). */
  childAuthoringMode: McpAuthoringMode | null;
  /** Minted tokens may create knowledge bases (an explicit opt-in). */
  childAllowCreate: boolean;
  /** Minted tokens stop when the key is revoked or expires, and can't outlive it. */
  childrenEndWithKey: boolean;
};

export function emptyApiKeyDraft(): ApiKeyDraft {
  return {
    reach: null,
    kbIds: [],
    bits: [],
    allowCreate: false,
    allowDelete: false,
    allowMintChildren: false,
    childToolGroups: ["read"],
    childAuthoringMode: null,
    childAllowCreate: false,
    childrenEndWithKey: false,
  };
}

export type ApiKeyDraftIssue =
  | "reachRequired"
  | "kbRequired"
  | "kbLacksBits"
  | "bitsRequired"
  | "createdNeedsCreate"
  | "deleteNeedsManage"
  | "toolGroupRequired"
  | "writeModeRequired";

/** The permissions the key's ceiling holds once implications are expanded. */
const draftCeiling = (draft: ApiKeyDraft): KbBit[] => expandKbBits(draft.bits);

/** Whether the user holds every ceiling bit on `kb` live (the server rejects, never clips). */
const kbHoldsCeiling = (kb: LiveKbOption, ceiling: readonly KbBit[]) =>
  ceiling.every((bit) => kb.bits.includes(bit));

/** The chosen KBs that are live, in the order the picker lists them. */
function chosenKbs(draft: ApiKeyDraft, live: readonly LiveKbOption[]): LiveKbOption[] {
  return live.filter((kb) => draft.kbIds.includes(kb.kbId));
}

/** Why the draft can't be minted yet; an empty list means it can. */
export function apiKeyDraftIssues(
  draft: ApiKeyDraft,
  live: readonly LiveKbOption[],
): ApiKeyDraftIssue[] {
  const issues: ApiKeyDraftIssue[] = [];
  const ceiling = draftCeiling(draft);
  if (draft.reach === null) issues.push("reachRequired");
  if (ceiling.length === 0) issues.push("bitsRequired");
  if (draft.reach === "selected") {
    const chosen = chosenKbs(draft, live);
    if (chosen.length === 0) issues.push("kbRequired");
    else if (!chosen.every((kb) => kbHoldsCeiling(kb, ceiling))) issues.push("kbLacksBits");
  }
  if (draft.reach === "created" && !draft.allowCreate) issues.push("createdNeedsCreate");
  if (draft.allowDelete && !ceiling.includes("manage")) issues.push("deleteNeedsManage");
  if (draft.allowMintChildren && draft.childToolGroups.length === 0) {
    issues.push("toolGroupRequired");
  }
  if (
    draft.allowMintChildren &&
    groupsWrite(draft.childToolGroups) &&
    draft.childAuthoringMode === null
  ) {
    issues.push("writeModeRequired");
  }
  return issues;
}

/** The exact `apiKeys.create` input for a draft without issues. */
export function toApiKeyMintInput(
  name: string,
  draft: ApiKeyDraft,
  live: readonly LiveKbOption[],
  /** null = never expires. */
  expiresAt: Date | null,
): ApiKeyMintInput {
  if (draft.reach === null) throw new Error("API key reach is required");
  return {
    name: name.trim(),
    reach: draft.reach,
    ...(draft.reach === "selected" ? { kbIds: chosenKbs(draft, live).map((kb) => kb.kbId) } : {}),
    bits: draftCeiling(draft),
    allowCreate: draft.allowCreate,
    allowDelete: draft.allowDelete,
    allowMintChildren: draft.allowMintChildren,
    ...(draft.allowMintChildren
      ? {
          childToolGroups: MCP_TOOL_GROUPS.filter((g) => draft.childToolGroups.includes(g)),
          childAuthoringMode: groupsWrite(draft.childToolGroups) ? draft.childAuthoringMode : null,
          ...(draft.childAllowCreate ? { childAllowCreate: true } : {}),
          ...(draft.childrenEndWithKey ? { childrenEndWithKey: true } : {}),
        }
      : {}),
    expiresAt,
  };
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

const CHILD_PRESETS = Object.keys(MCP_TOOL_PRESETS) as McpToolPreset[];

/** The tool-group picker's actions, applied to the minted tokens' groups. */
function childGroupsAfter(
  groups: readonly McpToolGroup[],
  action: SelectionAction,
): readonly McpToolGroup[] {
  const next =
    action.type === "setToolGroups"
      ? action.groups
      : action.type === "toggleToolGroup"
        ? toggle(groups, action.group)
        : groups;
  return MCP_TOOL_GROUPS.filter((group) => next.includes(group));
}

/**
 * Create → Dialog. Closing resets and unmounts the form; reopening owns a new
 * mutation observer, so a late reply can never reveal an abandoned secret.
 */
export function ApiKeyCreateDialog({
  open,
  onOpenChange,
  serverUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** This server's URL, for the minting example after the reveal. */
  serverUrl: string;
}) {
  return open ? <ApiKeyCreateForm onOpenChange={onOpenChange} serverUrl={serverUrl} /> : null;
}

function ApiKeyCreateForm({
  onOpenChange,
  serverUrl,
}: {
  onOpenChange: (open: boolean) => void;
  serverUrl: string;
}) {
  const { t } = useTranslation(["settings", "common", "errors"]);
  const queryClient = useQueryClient();
  const { query: kbQuery, live } = useLiveKbOptions();
  const [draft, setDraft] = useState<ApiKeyDraft>(emptyApiKeyDraft);
  const issues = apiKeyDraftIssues(draft, live);
  const mint = useMutation(
    withPatSecretHygiene(
      queryClient,
      orpc.apiKeys.create.mutationOptions(),
      API_KEY_LIST_QUERY_ROOT,
    ),
  );
  const blocked = mint.isError && !isPatMintRejection(mint.error);
  // Offline the request is never sent, so nothing can have been created: say so
  // and send nothing, instead of the "could not confirm" state a failed send gets.
  const [offlineRefused, setOfflineRefused] = useState(false);
  const form = useForm({
    defaultValues: { name: "", expiry: API_KEY_DEFAULT_EXPIRY, customDate: "" },
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
    onSubmit: ({ value }) => {
      if (issues.length > 0 || mint.isPending || blocked) return;
      const expiry = patExpiresAtFromChoice(value.expiry, value.customDate, new Date());
      if (!expiry.ok) return;
      setOfflineRefused(isBrowserOffline());
      if (isBrowserOffline()) return;
      mint.mutate(toApiKeyMintInput(value.name, draft, live, expiry.expiresAt));
    },
  });

  const close = (next: boolean) => {
    if (next) return onOpenChange(true);
    mint.reset();
    setOfflineRefused(false);
    form.reset();
    setDraft(emptyApiKeyDraft());
    onOpenChange(false);
  };

  const minted = mint.data;
  const mintErrorCode = (mint.error as { code?: unknown } | null)?.code;
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {minted ? t("settings:apiKeys.createdTitle") : t("settings:apiKeys.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {minted
              ? t("settings:apiKeys.createdDescription")
              : t("settings:apiKeys.createDescription")}
          </DialogDescription>
        </DialogHeader>
        {minted ? (
          <>
            <SecretReveal
              value={minted.secret}
              title={t("settings:apiKeys.secretOnce")}
              copyLabel={t("settings:apiKeys.copySecret")}
            />
            <ApiKeyNextSteps
              serverUrl={serverUrl}
              ceiling={
                mint.variables?.allowMintChildren
                  ? {
                      reach: mint.variables.reach,
                      bits: mint.variables.bits,
                      childToolGroups: mint.variables.childToolGroups ?? [],
                      childAuthoringMode: mint.variables.childAuthoringMode ?? null,
                    }
                  : null
              }
            />
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
                  label={t("settings:apiKeys.nameLabel")}
                  description={t("settings:apiKeys.nameHelp")}
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
                  description={t("settings:apiKeys.expiryHelp", { max: MAX_TTL_DAYS })}
                  valueLabel={
                    field.state.value === "custom"
                      ? t("settings:credentials.expiryCustom")
                      : field.state.value === "none"
                        ? t("settings:apiKeys.expiryNone")
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
                    {t("settings:apiKeys.expiryNone")}
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
                    {t("settings:apiKeys.noExpiryWarning")}
                  </p>
                ) : null
              }
            </form.Subscribe>
            <ApiKeyDraftPicker
              draft={draft}
              onChange={setDraft}
              live={live}
              disabled={mint.isPending}
              kbsError={kbQuery.isError}
              kbsPending={kbQuery.isPending}
              onRetryKbs={() => kbQuery.refetch()}
              kbsFooter={
                kbQuery.hasNextPage ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[44px]"
                    disabled={kbQuery.isFetchingNextPage}
                    onClick={() => kbQuery.fetchNextPage()}
                  >
                    {t("common:actions.loadMore")}
                  </Button>
                ) : null
              }
            />
            {offlineRefused && (
              <p role="alert" className="text-sm text-destructive">
                {t("errors:offline")}
              </p>
            )}
            {mint.isError && (
              <p role="alert" className="text-sm text-destructive">
                {mintErrorCode === "CONFLICT"
                  ? t("settings:apiKeys.createQuota")
                  : isPatMintRejection(mint.error)
                    ? t("settings:apiKeys.createError")
                    : t("settings:apiKeys.createUncertain", { name: mint.variables?.name ?? "" })}
              </p>
            )}
            <CreateFooter
              reasons={issues.map((issue) => t(`settings:apiKeys.issues.${issue}`))}
              pending={mint.isPending}
              blocked={blocked}
              submitLabel={t("settings:apiKeys.createSubmit")}
              pendingLabel={t("settings:credentials.creating")}
              onCancel={() => close(false)}
            />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type ApiKeyDraftPickerProps = {
  draft: ApiKeyDraft;
  onChange: (draft: ApiKeyDraft) => void;
  live: readonly LiveKbOption[];
  disabled: boolean;
  kbsError: boolean;
  kbsPending: boolean;
  onRetryKbs: () => void;
  kbsFooter?: React.ReactNode;
};

/**
 * Reach, permission ceiling, capabilities and the minted tokens' ceilings.
 * Exported for tests; the create dialog is its only caller.
 */
export function ApiKeyDraftPicker({
  draft,
  onChange,
  live,
  disabled,
  kbsError,
  kbsPending,
  onRetryKbs,
  kbsFooter,
}: ApiKeyDraftPickerProps) {
  const { t } = useTranslation("settings");
  const base = useId();
  const ceiling = draftCeiling(draft);
  const hasManage = ceiling.includes("manage");
  const childPreset = presetFor(draft.childToolGroups);
  const childWrites = groupsWrite(draft.childToolGroups);
  const set = (patch: Partial<ApiKeyDraft>) => onChange({ ...draft, ...patch });
  const bitLabels = (bits: readonly KbBit[]) =>
    bits.map((bit) => t(`credentials.picker.bits.${bit}.label`)).join(", ");
  // What a minted token could reach, for the tool preview. KBs the key
  // creates join its reach, so they are a preview entry of their own.
  const reachedKbs =
    draft.reach === "all"
      ? live.map((kb) => ({ name: kb.name, bits: ceiling.filter((b) => kb.bits.includes(b)) }))
      : draft.reach === "selected"
        ? live
            .filter((kb) => draft.kbIds.includes(kb.kbId))
            .map((kb) => ({ name: kb.name, bits: ceiling }))
        : [];
  const previewKbs =
    draft.allowCreate || draft.reach === "created"
      ? [...reachedKbs, { name: t("apiKeys.previewCreatedKbs"), bits: ceiling }]
      : reachedKbs;

  return (
    <div className="min-w-0 space-y-6">
      <RadioCards<ApiKeyReach>
        legend={t("apiKeys.reach.legend")}
        options={API_KEY_REACHES.map((reach) => ({
          value: reach,
          label: t(`apiKeys.reach.${reach}.label`),
          description: t(`apiKeys.reach.${reach}.description`),
        }))}
        value={draft.reach}
        disabled={disabled}
        onChange={(reach) => set({ reach })}
      />

      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{t("apiKeys.bitsLegend")}</legend>
        <p className="text-sm text-muted-foreground">{t("apiKeys.bitsHint")}</p>
        {KB_BITS.map((bit) => {
          const ticked = draft.bits.includes(bit);
          const implied = !ticked && ceiling.includes(bit);
          return (
            <CheckRow
              key={bit}
              id={`${base}-bit-${bit}`}
              checked={ticked || implied}
              disabled={disabled || implied}
              onToggle={() => set({ bits: toggle(draft.bits, bit) })}
              label={t(`credentials.picker.bits.${bit}.label`)}
              description={t(`credentials.picker.bits.${bit}.description`)}
            />
          );
        })}
      </fieldset>

      {draft.reach === "selected" && (
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">{t("apiKeys.kbsLegend")}</legend>
          <p className="text-sm text-muted-foreground">{t("apiKeys.kbsHint")}</p>
          {kbsError ? (
            <InlineRetry message={t("credentials.kbsLoadError")} onRetry={onRetryKbs} />
          ) : !kbsPending && live.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("apiKeys.noKbs")}</p>
          ) : (
            live.map((kb) => {
              const checked = draft.kbIds.includes(kb.kbId);
              const holds = kbHoldsCeiling(kb, ceiling);
              return (
                <CheckRow
                  key={kb.kbId}
                  id={`${base}-kb-${kb.kbId}`}
                  checked={checked}
                  // A KB that lacks a ceiling bit can't be added, only removed.
                  disabled={disabled || kbsPending || (!checked && !holds)}
                  onToggle={() => set({ kbIds: toggle(draft.kbIds, kb.kbId) })}
                  label={kb.name}
                  description={
                    holds
                      ? t("apiKeys.kbYourAccess", { bits: bitLabels(kb.bits) })
                      : t("apiKeys.kbLacks", {
                          bits: bitLabels(ceiling.filter((b) => !kb.bits.includes(b))),
                        })
                  }
                />
              );
            })
          )}
          {kbsFooter}
        </fieldset>
      )}

      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{t("apiKeys.capabilitiesLegend")}</legend>
        <CheckRow
          id={`${base}-create`}
          checked={draft.allowCreate}
          disabled={disabled}
          onToggle={() => set({ allowCreate: !draft.allowCreate })}
          label={t("apiKeys.allowCreate.label")}
          description={t("apiKeys.allowCreate.description")}
        />
        <CheckRow
          id={`${base}-delete`}
          checked={draft.allowDelete}
          // Without Manage the key could never delete; a ticked box stays removable.
          disabled={disabled || (!hasManage && !draft.allowDelete)}
          onToggle={() => set({ allowDelete: !draft.allowDelete })}
          label={t("apiKeys.allowDelete.label")}
          description={
            hasManage ? t("apiKeys.allowDelete.description") : t("apiKeys.allowDelete.needsManage")
          }
        />
        <CheckRow
          id={`${base}-mint`}
          checked={draft.allowMintChildren}
          disabled={disabled}
          onToggle={() => set({ allowMintChildren: !draft.allowMintChildren })}
          label={t("apiKeys.allowMint.label")}
          description={t("apiKeys.allowMint.description")}
        />
      </fieldset>

      {draft.allowMintChildren && (
        <div className="min-w-0 space-y-6 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">{t("apiKeys.childHint")}</p>
          <RadioCards<McpToolPreset | "custom">
            legend={t("apiKeys.childPurposeLegend")}
            options={[
              ...CHILD_PRESETS.map((value) => ({
                value,
                label: t(`credentials.picker.presets.${value}.label`),
                description: t(`credentials.picker.presets.${value}.description`),
              })),
              ...(childPreset === "custom"
                ? [
                    {
                      value: "custom" as const,
                      label: t("credentials.picker.presets.custom.label"),
                      description: t("credentials.picker.presets.custom.description"),
                    },
                  ]
                : []),
            ]}
            value={childPreset}
            disabled={disabled}
            onChange={(next) => {
              if (next !== "custom") set({ childToolGroups: MCP_TOOL_PRESETS[next] });
            }}
          />
          {childWrites && (
            <AuthoringModePicker
              value={draft.childAuthoringMode}
              onChange={(mode) => set({ childAuthoringMode: mode })}
              disabled={disabled}
            />
          )}
          <CheckRow
            id={`${base}-children-end`}
            checked={draft.childrenEndWithKey}
            disabled={disabled}
            onToggle={() => set({ childrenEndWithKey: !draft.childrenEndWithKey })}
            label={t("apiKeys.childrenEndWithKey.label")}
            description={t(
              draft.childrenEndWithKey
                ? "apiKeys.childrenEndWithKey.on"
                : "apiKeys.childrenEndWithKey.off",
            )}
          />
          <AdvancedSection
            label={t("apiKeys.childAdvanced")}
            defaultOpen={childPreset === "custom"}
          >
            <ToolGroupPicker
              groups={draft.childToolGroups}
              onChange={(action) =>
                set({ childToolGroups: childGroupsAfter(draft.childToolGroups, action) })
              }
              writeScope={childWrites}
              authoringMode={childWrites ? draft.childAuthoringMode : null}
              allowCreate={draft.childAllowCreate}
              offerSealed
              kbs={previewKbs}
              createdKbBits={draft.childAllowCreate ? ceiling : []}
              disabled={disabled}
              showPresets={false}
            />
            {draft.childToolGroups.includes("sealed") && (
              <p role="status" className="text-sm text-destructive">
                {t("apiKeys.childSealedWarning")}
              </p>
            )}
            <CheckRow
              id={`${base}-child-create`}
              checked={draft.childAllowCreate}
              disabled={disabled}
              onToggle={() => set({ childAllowCreate: !draft.childAllowCreate })}
              label={t("apiKeys.childAllowCreate.label")}
              description={t("apiKeys.childAllowCreate.description")}
            />
          </AdvancedSection>
        </div>
      )}
    </div>
  );
}
