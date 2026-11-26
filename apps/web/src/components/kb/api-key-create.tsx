import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import type { McpAuthoringMode } from "@knowledge-base/auth/mcp-authoring-mode";
import {
  MCP_TOOL_GROUPS,
  MCP_TOOL_PRESETS,
  type McpToolGroup,
  type McpToolPreset,
} from "@knowledge-base/auth/mcp-tool-groups";
import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { AdvancedSection, FormPage, FormSection } from "@knowledge-base/ui/components/form-page";
import { SelectField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type * as React from "react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { ApiKeyNextSteps } from "@/components/kb/api-key-next-steps";
import { AuthoringModePicker } from "@/components/kb/authoring-mode-picker";
import { CheckRow } from "@/components/kb/check-row";
import {
  BackLink,
  CreateActions,
  FormIssue,
  focusFirstProblem,
  scrollPageToTop,
} from "@/components/kb/credential-form-parts";
import {
  EXPIRY_CHOICES,
  EXPIRY_PRESETS,
  expiryChoiceLabel,
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
 * Everything the create page chooses besides the name and expiry. It starts
 * on the least a key can be: Read on knowledge bases you choose (none is
 * chosen for you), with no capability. Minted tokens start on the Read tool
 * group, read-only, without sealed values or KB creation, and independent of
 * the key (they outlive it). Nothing that changes data is ever preselected.
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

export function defaultApiKeyDraft(): ApiKeyDraft {
  return {
    reach: "selected",
    kbIds: [],
    bits: ["read"],
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

/**
 * The permission choices: each is one permission with everything it implies
 * (Write includes Propose and Read; Manage includes all). Any other set,
 * such as Review alone, is Custom, which shows the single permissions.
 */
const BIT_PRESETS = ["read", "propose", "write", "manage"] as const satisfies readonly KbBit[];
type BitPreset = (typeof BIT_PRESETS)[number] | "custom";

/** The preset a set of permissions matches once expanded, or "custom". */
export function bitPresetFor(bits: readonly KbBit[]): BitPreset {
  const expanded = expandKbBits(bits).join();
  return BIT_PRESETS.find((preset) => expandKbBits([preset]).join() === expanded) ?? "custom";
}

/** Which part of the page each problem is about, so it shows right there. */
const ISSUE_PLACE: Record<ApiKeyDraftIssue, "reach" | "kbs" | "bits" | "capabilities" | "child"> = {
  reachRequired: "reach",
  kbRequired: "kbs",
  kbLacksBits: "kbs",
  bitsRequired: "bits",
  createdNeedsCreate: "capabilities",
  deleteNeedsManage: "capabilities",
  toolGroupRequired: "child",
  writeModeRequired: "child",
};

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

const LIST_PATH = "/$lang/settings/api-keys" as const;

/** One line naming what Create will make: reach, permissions, capabilities, expiry. */
export function apiKeyDraftSummary(
  t: TFunction<"settings">,
  draft: ApiKeyDraft,
  expiry: string,
): string {
  const ceiling = draftCeiling(draft);
  const capabilities = [
    draft.allowCreate && t("apiKeys.can.create"),
    draft.allowDelete && t("apiKeys.can.delete"),
    draft.allowMintChildren && t("apiKeys.can.mint"),
  ].filter((item): item is string => typeof item === "string");
  return [
    draft.reach === null
      ? null
      : t(`apiKeys.reachSummary.${draft.reach}`, {
          count: draft.reach === "selected" ? draft.kbIds.length : 0,
        }),
    t("apiKeys.bitsSummary", {
      bits: ceiling.map((bit) => t(`credentials.picker.bits.${bit}.label`)).join(", "),
    }),
    capabilities.length === 0
      ? t("apiKeys.can.none")
      : t("apiKeys.can.list", { items: capabilities.join(", ") }),
    expiry,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Create → a page of its own: the key's name, reach and permissions up
 * front, its lifetime and the minted tokens' tools under Advanced. Leaving the page drops the mutation observer, so a late
 * reply can never reveal an abandoned secret; after the mint the page shows
 * the secret once and the next step.
 * See docs/ui.md § Form surfaces
 */
export function ApiKeyCreatePage({ lang, serverUrl }: { lang: string; serverUrl: string }) {
  const { t } = useTranslation(["settings", "common", "errors"]);
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const { query: kbQuery, live } = useLiveKbOptions();
  const [draft, setDraft] = useState<ApiKeyDraft>(defaultApiKeyDraft);
  // Problems show next to their part of the page once Create was pressed.
  const [showIssues, setShowIssues] = useState(false);
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
      // Per call, so it runs only while this page is still mounted (a late
      // reply after leaving must not scroll whatever page is open by then).
      mint.mutate(toApiKeyMintInput(value.name, draft, live, expiry.expiresAt), {
        onSuccess: () => scrollPageToTop(),
      });
    },
  });

  const minted = mint.data;
  if (minted) {
    return (
      <FormPage
        onSubmit={(event) => event.preventDefault()}
        back={<BackLink to={LIST_PATH} lang={lang} />}
        title={t("settings:apiKeys.createdTitle")}
        description={t("settings:apiKeys.createdDescription")}
        actions={
          <Link
            to={LIST_PATH}
            params={{ lang }}
            className={buttonVariants({ size: "touch" })}
            data-testid="api-key-done"
          >
            {t("settings:credentials.done")}
          </Link>
        }
        bodyClassName="max-w-3xl"
      >
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
      </FormPage>
    );
  }

  const mintErrorCode = (mint.error as { code?: unknown } | null)?.code;
  // Shown in the sticky action bar, where Create was pressed.
  const submitAlert = offlineRefused
    ? t("errors:offline")
    : !mint.isError
      ? undefined
      : mintErrorCode === "CONFLICT"
        ? t("settings:apiKeys.createQuota")
        : isPatMintRejection(mint.error)
          ? t("settings:apiKeys.createError")
          : t("settings:apiKeys.createUncertain", { name: mint.variables?.name ?? "" });
  return (
    <FormPage
      ref={formRef}
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        setShowIssues(true);
        await form.handleSubmit();
        focusFirstProblem(formRef.current);
      }}
      back={<BackLink to={LIST_PATH} lang={lang} />}
      title={t("settings:apiKeys.createTitle")}
      description={t("settings:apiKeys.createDescription")}
      actions={
        <form.Subscribe
          selector={(state) => [state.values.expiry, state.values.customDate] as const}
        >
          {([expiry, customDate]) => (
            <CreateActions
              reasons={issues.map((issue) => t(`settings:apiKeys.issues.${issue}`))}
              summary={apiKeyDraftSummary(
                t,
                draft,
                expiryChoiceLabel(t, expiry, customDate, "apiKeys.expiryNone"),
              )}
              pending={mint.isPending}
              blocked={blocked}
              submitLabel={t("settings:apiKeys.createSubmit")}
              pendingLabel={t("settings:credentials.creating")}
              cancelTo={LIST_PATH}
              lang={lang}
              alert={submitAlert}
            />
          )}
        </form.Subscribe>
      }
    >
      <FormSection title={t("settings:apiKeys.sections.key")}>
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
      </FormSection>
      <ApiKeyDraftPicker
        draft={draft}
        onChange={setDraft}
        live={live}
        issues={showIssues ? issues : []}
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
        lifetime={
          <form.Subscribe
            selector={(state) => [state.values.expiry, state.values.customDate] as const}
          >
            {([expiry, customDate]) => (
              <AdvancedSection
                title={t("settings:credentials.lifetime")}
                summary={expiryChoiceLabel(t, expiry, customDate, "apiKeys.expiryNone")}
              >
                <form.Field name="expiry">
                  {(field) => (
                    <SelectField
                      field={field}
                      label={t("settings:credentials.expiryLabel")}
                      description={t("settings:apiKeys.expiryHelp", { max: MAX_TTL_DAYS })}
                      options={[
                        ...EXPIRY_PRESETS.map((days) => ({
                          value: days,
                          label: t("settings:credentials.expiryDays", { count: Number(days) }),
                        })),
                        { value: "custom", label: t("settings:credentials.expiryCustom") },
                        { value: "none", label: t("settings:apiKeys.expiryNone") },
                      ]}
                    />
                  )}
                </form.Field>
                {expiry === "custom" ? (
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
                ) : null}
              </AdvancedSection>
            )}
          </form.Subscribe>
        }
      />
    </FormPage>
  );
}

type ApiKeyDraftPickerProps = {
  draft: ApiKeyDraft;
  onChange: (draft: ApiKeyDraft) => void;
  live: readonly LiveKbOption[];
  /** The problems to show next to their part of the page (empty until Create is pressed). */
  issues?: readonly ApiKeyDraftIssue[];
  disabled: boolean;
  kbsError: boolean;
  kbsPending: boolean;
  onRetryKbs: () => void;
  kbsFooter?: React.ReactNode;
  /** The key's lifetime section, placed among the Advanced sections. */
  lifetime?: React.ReactNode;
};

/**
 * Reach, permission ceiling, capabilities and the minted tokens' ceilings,
 * as the create page's sections. Exported for tests; the create page is its
 * only caller.
 */
export function ApiKeyDraftPicker({
  draft,
  onChange,
  live,
  issues = [],
  disabled,
  kbsError,
  kbsPending,
  onRetryKbs,
  kbsFooter,
  lifetime,
}: ApiKeyDraftPickerProps) {
  const { t } = useTranslation("settings");
  const base = useId();
  const ceiling = draftCeiling(draft);
  const hasManage = ceiling.includes("manage");
  const bitPreset = bitPresetFor(draft.bits);
  // Custom stays open once chosen, even when its ticks happen to match a preset.
  const [customBits, setCustomBits] = useState(bitPreset === "custom");
  const childPreset = presetFor(draft.childToolGroups);
  const childWrites = groupsWrite(draft.childToolGroups);
  const set = (patch: Partial<ApiKeyDraft>) => onChange({ ...draft, ...patch });
  const issueAt = (place: (typeof ISSUE_PLACE)[ApiKeyDraftIssue]) => {
    const issue = issues.find((candidate) => ISSUE_PLACE[candidate] === place);
    return issue ? t(`apiKeys.issues.${issue}`) : undefined;
  };
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
  const childGroupLabels = draft.childToolGroups
    .map((group) => t(`credentials.picker.groups.${group}.label`))
    .join(", ");

  return (
    <>
      <FormSection title={t("apiKeys.sections.access")} description={t("apiKeys.bitsHint")}>
        <div className="min-w-0 space-y-2">
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
          <FormIssue message={issueAt("reach")} />
        </div>
        <div className="min-w-0 space-y-2">
          <RadioCards<BitPreset>
            legend={t("apiKeys.bitsLegend")}
            options={[
              ...BIT_PRESETS.map((preset) => ({
                value: preset,
                label: t(`credentials.picker.bits.${preset}.label`),
                description: t(`apiKeys.bitPresets.${preset}`),
              })),
              {
                value: "custom" as const,
                label: t("apiKeys.bitPresets.customLabel"),
                description: t("apiKeys.bitPresets.custom"),
              },
            ]}
            value={customBits ? "custom" : bitPreset}
            disabled={disabled}
            onChange={(next) => {
              setCustomBits(next === "custom");
              if (next !== "custom") set({ bits: [next] });
            }}
          />
          {customBits && (
            <fieldset className="min-w-0 space-y-2 border-l-2 pl-3">
              <legend className="sr-only">{t("apiKeys.bitsLegend")}</legend>
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
          )}
          <FormIssue message={issueAt("bits")} />
        </div>
      </FormSection>

      {draft.reach === "selected" && (
        <FormSection title={t("apiKeys.kbsLegend")} description={t("apiKeys.kbsHint")}>
          <fieldset className="min-w-0 space-y-2 lg:col-span-2">
            <legend className="sr-only">{t("apiKeys.kbsLegend")}</legend>
            {kbsError ? (
              <InlineRetry message={t("credentials.kbsLoadError")} onRetry={onRetryKbs} />
            ) : !kbsPending && live.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("apiKeys.noKbs")}</p>
            ) : (
              <div className="grid grid-cols-1 gap-x-6 gap-y-2 lg:grid-cols-2">
                {live.map((kb) => {
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
                })}
              </div>
            )}
            {kbsFooter}
            <FormIssue message={issueAt("kbs")} />
          </fieldset>
        </FormSection>
      )}

      <FormSection
        title={t("apiKeys.capabilitiesLegend")}
        description={t("apiKeys.capabilitiesHint")}
      >
        <fieldset className="min-w-0 space-y-2 lg:col-span-2">
          <legend className="sr-only">{t("apiKeys.capabilitiesLegend")}</legend>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 lg:grid-cols-3">
            <CheckRow
              id={`${base}-mint`}
              checked={draft.allowMintChildren}
              disabled={disabled}
              onToggle={() => set({ allowMintChildren: !draft.allowMintChildren })}
              label={t("apiKeys.allowMint.label")}
              description={t("apiKeys.allowMint.description")}
            />
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
                hasManage
                  ? t("apiKeys.allowDelete.description")
                  : t("apiKeys.allowDelete.needsManage")
              }
            />
          </div>
          <FormIssue message={issueAt("capabilities")} />
        </fieldset>
      </FormSection>

      {draft.allowMintChildren && (
        <FormSection title={t("apiKeys.sections.tokens")} description={t("apiKeys.childHint")}>
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
          <div className="min-w-0 space-y-4">
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
            <FormIssue message={issueAt("child")} />
          </div>
        </FormSection>
      )}

      {lifetime}

      {draft.allowMintChildren && (
        <AdvancedSection
          title={t("apiKeys.childAdvanced")}
          summary={[
            t("apiKeys.childGroupsSummary", { groups: childGroupLabels }),
            draft.childAllowCreate ? t("apiKeys.childAllowCreateSummary") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          gridClassName="lg:grid-cols-1"
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
      )}
    </>
  );
}
