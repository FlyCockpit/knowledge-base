import { MCP_TOOL_PRESETS, type McpToolPreset } from "@knowledge-base/auth/mcp-tool-groups";
import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { AdvancedSection, FormPage, FormSection } from "@knowledge-base/ui/components/form-page";
import { SelectField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { CreateCapabilityPicker, KbAccessPicker } from "@/components/kb/acl-picker";
import { AuthoringModePicker } from "@/components/kb/authoring-mode-picker";
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
  PatSecretReveal,
  patDraftGrant,
  patDraftIssueKeys,
  patExpiresAtFromChoice,
  withPatSecretHygiene,
} from "@/components/kb/credential-list";
import { McpClientSetup } from "@/components/kb/mcp-connect";
import { RadioCards } from "@/components/kb/radio-cards";
import { presetFor, ToolGroupPicker } from "@/components/kb/tool-group-picker";
import {
  type CredentialSelection,
  effectiveSelection,
  emptySelection,
  type GrantSelection,
  type LiveKbOption,
  type SelectionAction,
  type SelectionIssue,
  selectionIssues,
  selectionReducer,
  useLiveKbOptions,
} from "@/hooks/use-mcp-consent";
import { isBrowserOffline } from "@/lib/network-failure";
import { orpc } from "@/utils/orpc";

const LIST_PATH = "/$lang/settings/mcp" as const;
const DEFAULT_EXPIRY: PatExpiryChoice = "90";
const PURPOSE_PRESETS = Object.keys(MCP_TOOL_PRESETS) as McpToolPreset[];

/** The answers to "What should this token do?": a tool preset, or a custom group set from Advanced. */
type TokenPurpose = McpToolPreset | "custom";

/** Which part of the page each draft problem is about, so it shows right there. */
type IssuePlace = "purpose" | "writeMode" | "tools";
const ISSUE_PLACE: Record<SelectionIssue, IssuePlace> = {
  scopeRequired: "purpose",
  toolGroupRequired: "tools",
  createNeedsRead: "tools",
  createNeedsWriteScope: "tools",
  writeModeRequired: "writeMode",
};

/** Where the first problem of each place is, as a translation key (or nothing). */
export function patIssuesByPlace(grant: GrantSelection): Partial<Record<IssuePlace, string>> {
  const keys = patDraftIssueKeys(grant);
  const places: Partial<Record<IssuePlace, string>> = {};
  selectionIssues(grant).forEach((issue, index) => {
    const place = ISSUE_PLACE[issue];
    if (!places[place]) places[place] = keys[index];
  });
  return places;
}

/**
 * The token's starting draft: the Read purpose (search and read documents,
 * nothing can change), on no knowledge base yet. Nothing that changes data,
 * no knowledge base and no write mode is ever preselected.
 */
export function defaultPatSelection(): CredentialSelection {
  return { ...emptySelection(), toolGroups: MCP_TOOL_PRESETS.read };
}

/** One line naming what Create will make: purpose, knowledge bases, expiry. */
export function patDraftSummary(
  t: TFunction<"settings">,
  purpose: TokenPurpose,
  grant: GrantSelection,
  live: readonly LiveKbOption[],
  expiry: string,
): string {
  const chosen = new Set(grant.acl.filter((entry) => entry.bits.length > 0).map((e) => e.kbId));
  const kbs = live.filter((kb) => chosen.has(kb.kbId)).map((kb) => kb.name);
  return [
    t(`credentials.picker.presets.${purpose}.label`),
    kbs.length > 0 ? kbs.join(", ") : t("credentials.picker.previewNoKbs"),
    grant.allowCreate ? t("credentials.picker.previewCreated") : null,
    expiry,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Create → a page of its own. The token starts
 * on Read; the knowledge bases are chosen, never preselected. Lifetime and
 * the tool groups sit under Advanced. Leaving the page drops the mutation
 * observer, so a late reply cannot reveal an abandoned secret; after the mint
 * the page shows the secret once and how to connect a client.
 * See docs/ui.md § Form surfaces
 */
export function PatCreatePage({ lang, serverUrl }: { lang: string; serverUrl: string }) {
  const { t } = useTranslation(["settings", "common", "errors"]);
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const { query: kbQuery, live } = useLiveKbOptions();
  const [selection, dispatch] = useReducer(selectionReducer, undefined, defaultPatSelection);
  // Problems show next to their part of the page once Create was pressed.
  const [showIssues, setShowIssues] = useState(false);
  const grant = patDraftGrant(selection, live);
  const issues = patDraftIssueKeys(grant);
  const issueAt = showIssues ? patIssuesByPlace(grant) : {};
  const writes = grant.scopes.includes("mcp:write");
  const purpose: TokenPurpose = presetFor(selection.toolGroups);
  const mint = useMutation(
    withPatSecretHygiene(queryClient, orpc.mcpTokens.create.mutationOptions()),
  );
  const blocked = mint.isError && !isPatMintRejection(mint.error);
  // Offline the request is never sent, so nothing can have been created: say so
  // and send nothing, instead of the "could not confirm" state a failed send gets.
  const [offlineRefused, setOfflineRefused] = useState(false);
  const form = useForm({
    defaultValues: { name: "", expiry: DEFAULT_EXPIRY, customDate: "" },
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
      mint.mutate(
        {
          name: value.name.trim(),
          scopes: grant.scopes.filter((s) => s !== "offline_access"),
          toolGroups: grant.toolGroups,
          acl: grant.acl,
          allowCreate: grant.allowCreate,
          createdKbBits: grant.createdKbBits,
          authoringMode: grant.authoringMode,
          expiresAt: expiry.expiresAt,
        },
        { onSuccess: () => scrollPageToTop() },
      );
    },
  });

  const disabled = mint.isPending || kbQuery.isPending;
  // Shown in the sticky action bar, where Create was pressed.
  const submitAlert = offlineRefused
    ? t("errors:offline")
    : !mint.isError
      ? undefined
      : isPatMintRejection(mint.error)
        ? t("settings:credentials.createError")
        : t("settings:credentials.createUncertain", { name: mint.variables?.name ?? "" });
  const effective = effectiveSelection(selection);

  const minted = mint.data;
  if (minted) {
    return (
      <FormPage
        onSubmit={(event) => event.preventDefault()}
        back={<BackLink to={LIST_PATH} lang={lang} />}
        title={t("settings:credentials.createdTitle")}
        description={t("settings:credentials.createdDescription")}
        actions={
          <Link
            to={LIST_PATH}
            params={{ lang }}
            className={buttonVariants({ size: "touch" })}
            data-testid="pat-done"
          >
            {t("settings:credentials.done")}
          </Link>
        }
        bodyClassName="max-w-3xl"
      >
        <PatSecretReveal secret={minted.secret} />
        <section className="min-w-0 space-y-2" aria-labelledby="pat-next-connect">
          <h2 id="pat-next-connect" className="text-base font-medium">
            {t("settings:credentials.nextConnect")}
          </h2>
          <McpClientSetup serverUrl={serverUrl} token={minted.secret} />
        </section>
      </FormPage>
    );
  }

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
      title={t("settings:credentials.createTitle")}
      description={t("settings:credentials.createDescription")}
      actions={
        <form.Subscribe
          selector={(state) => [state.values.expiry, state.values.customDate] as const}
        >
          {([expiry, customDate]) => (
            <CreateActions
              reasons={issues.map((key) => t(key))}
              summary={patDraftSummary(
                t,
                purpose,
                grant,
                live,
                expiryChoiceLabel(t, expiry, customDate, "credentials.expiryNone"),
              )}
              pending={mint.isPending}
              blocked={blocked}
              submitLabel={t("settings:credentials.createSubmit")}
              pendingLabel={t("settings:credentials.creating")}
              cancelTo={LIST_PATH}
              lang={lang}
              alert={submitAlert}
            />
          )}
        </form.Subscribe>
      }
    >
      <FormSection title={t("settings:credentials.sections.token")}>
        <form.Field name="name">
          {(field) => (
            <TextField
              field={field}
              label={t("settings:credentials.nameLabel")}
              description={t("settings:credentials.nameHelp")}
              autoComplete="off"
              inputMode="text"
              maxLength={100}
            />
          )}
        </form.Field>
        <div className="min-w-0 space-y-4 lg:row-span-2">
          <RadioCards<TokenPurpose>
            legend={t("settings:credentials.purposeLegend")}
            options={[
              ...PURPOSE_PRESETS.map((value) => ({
                value,
                label: t(`settings:credentials.picker.presets.${value}.label`),
                description: t(`settings:credentials.picker.presets.${value}.description`),
              })),
              ...(purpose === "custom"
                ? [
                    {
                      value: "custom" as const,
                      label: t("settings:credentials.picker.presets.custom.label"),
                      description: t("settings:credentials.picker.presets.custom.description"),
                    },
                  ]
                : []),
            ]}
            value={purpose}
            disabled={disabled}
            onChange={(next) => {
              if (next !== "custom")
                dispatch({ type: "setToolGroups", groups: MCP_TOOL_PRESETS[next] });
            }}
          />
          <FormIssue message={issueAt.purpose ? t(issueAt.purpose) : undefined} />
          {writes && (
            <AuthoringModePicker
              value={selection.authoringMode}
              onChange={(mode) => dispatch({ type: "setAuthoringMode", mode })}
              disabled={disabled}
            />
          )}
          <FormIssue message={issueAt.writeMode ? t(issueAt.writeMode) : undefined} />
        </div>
      </FormSection>

      <FormSection
        title={t("settings:credentials.picker.kbsLegend")}
        description={t("settings:credentials.picker.kbsHint")}
        gridClassName="lg:grid-cols-1"
      >
        <div className="min-w-0 space-y-3">
          {kbQuery.isError ? (
            <InlineRetry
              message={t("settings:credentials.kbsLoadError")}
              onRetry={() => kbQuery.refetch()}
            />
          ) : (
            <KbAccessPicker
              live={live}
              selection={selection}
              onChange={dispatch}
              disabled={disabled}
              headless
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
        </div>
      </FormSection>

      <form.Subscribe selector={(state) => [state.values.expiry, state.values.customDate] as const}>
        {([expiry, customDate]) => (
          <AdvancedSection
            title={t("settings:credentials.lifetime")}
            summary={expiryChoiceLabel(t, expiry, customDate, "credentials.expiryNone")}
          >
            <form.Field name="expiry">
              {(field) => (
                <SelectField
                  field={field}
                  label={t("settings:credentials.expiryLabel")}
                  description={t("settings:credentials.expiryHelp", { max: MAX_TTL_DAYS })}
                  // The value is a day count ("90"); show it with its unit.
                  options={[
                    ...EXPIRY_PRESETS.map((days) => ({
                      value: days,
                      label: t("settings:credentials.expiryDays", { count: Number(days) }),
                    })),
                    { value: "custom", label: t("settings:credentials.expiryCustom") },
                    { value: "none", label: t("settings:credentials.expiryNone") },
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
                {t("settings:credentials.noExpiryWarning")}
              </p>
            ) : null}
          </AdvancedSection>
        )}
      </form.Subscribe>

      <AdvancedSection
        title={t("settings:credentials.advanced")}
        summary={[
          t("settings:credentials.toolGroupsSummary", {
            groups: effective.toolGroups
              .map((group) => t(`settings:credentials.picker.groups.${group}.label`))
              .join(", "),
          }),
          effective.allowCreate ? t("settings:credentials.picker.previewCreated") : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        gridClassName="lg:grid-cols-1"
      >
        <ToolGroupPicker
          groups={effective.toolGroups}
          onChange={dispatch}
          writeScope={writes}
          authoringMode={selection.authoringMode}
          allowCreate={effective.allowCreate}
          offerSealed
          kbs={live.flatMap((kb) => {
            const bits = effective.acl[kb.kbId] ?? [];
            return bits.length ? [{ name: kb.name, bits }] : [];
          })}
          createdKbBits={effective.allowCreate ? effective.createdKbBits : []}
          disabled={disabled}
          showPresets={false}
        />
        {/* Creating needs the kb_admin group, which writes: ticking it chooses write access. */}
        <CreateCapabilityPicker
          selection={selection}
          onChange={(action: SelectionAction) => dispatch(action)}
          writeScopeSelected
          disabled={disabled}
        />
        <FormIssue message={issueAt.tools ? t(issueAt.tools) : undefined} />
      </AdvancedSection>
    </FormPage>
  );
}
