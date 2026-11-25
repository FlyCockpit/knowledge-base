import type { McpAuthoringMode } from "@knowledge-base/auth/mcp-authoring-mode";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { AuthoringModePicker } from "@/components/kb/authoring-mode-picker";
import { CheckRow } from "@/components/kb/check-row";
import { ToolGroupPicker } from "@/components/kb/tool-group-picker";
import {
  allowedKbBits,
  type CredentialSelection,
  effectiveSelection,
  KB_BITS,
  type KbBit,
  type LiveKbOption,
  SELECTABLE_SCOPES,
  type SelectableScope,
  type SelectionAction,
} from "@/hooks/use-mcp-consent";

type AclPickerProps = {
  /** Live KBs the user holds, with the bits they hold on each. */
  live: readonly LiveKbOption[];
  selection: CredentialSelection;
  onChange: (action: SelectionAction) => void;
  /** `select`: PAT creation picks scopes. `fixed`: scopes come from a signed request. */
  scopeMode: "select" | "fixed";
  fixedScopes?: readonly string[];
  /** Whether `mcp:write` is part of the credential (required for creating KBs). */
  writeScopeSelected?: boolean;
  /** PAT and CLI device credentials may resolve sealed values; OAuth apps never do. */
  offerSealed?: boolean;
  disabled?: boolean;
  /**
   * Editing a grant: stored bits the user no longer holds live, per KB. They
   * show checked and can be removed, but never added back.
   */
  removalOnly?: Readonly<Record<string, readonly KbBit[]>>;
  /** The write modes on offer while `mcp:write` is part of the credential (a device ceiling). */
  authoringModes?: readonly McpAuthoringMode[];
  /** Set when the write mode cannot change here (temporary access); the picker is shown disabled. */
  authoringModeLockedReason?: string;
};

const SCOPE_KEY: Record<string, "read" | "write" | "offline"> = {
  "mcp:read": "read",
  "mcp:write": "write",
  offline_access: "offline",
};

/**
 * Shared credential ceiling picker for OAuth consent, CLI device approval and
 * PAT creation. Every scope, KB and bit checkbox starts unchecked; there is
 * deliberately no "select all". Tool groups start on the Read preset. With
 * write access a write mode must be chosen; none is preselected.
 * Each KB is its own fieldset listing only the bits the user holds live.
 */
export function AclPicker({
  live,
  selection: draft,
  onChange,
  scopeMode,
  fixedScopes = [],
  writeScopeSelected = false,
  offerSealed = false,
  disabled = false,
  removalOnly = {},
  authoringModes,
  authoringModeLockedReason,
}: AclPickerProps) {
  const { t } = useTranslation("settings");
  const base = useId();
  // Display exactly what would be submitted: bits above the preset's ceiling never show.
  const selection = effectiveSelection(draft);
  const id = (...parts: string[]) => `${base}-${parts.join("-")}`;

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t("credentials.picker.scopesLegend")}</legend>
        {scopeMode === "select" ? (
          SELECTABLE_SCOPES.map((scope) => (
            <CheckRow
              key={scope}
              id={id("scope", scope)}
              checked={selection.scopes.includes(scope)}
              disabled={disabled}
              onToggle={() => onChange({ type: "toggleScope", scope: scope as SelectableScope })}
              label={t(`credentials.picker.scopes.${SCOPE_KEY[scope]}`)}
            />
          ))
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {fixedScopes.map((scope) => (
              <li key={scope}>
                {SCOPE_KEY[scope]
                  ? t(`credentials.picker.scopes.${SCOPE_KEY[scope]}`)
                  : t("credentials.picker.scopes.unknown", { scope })}
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {writeScopeSelected && (
        <AuthoringModePicker
          value={selection.authoringMode}
          onChange={(mode) => onChange({ type: "setAuthoringMode", mode })}
          allowed={authoringModes}
          disabled={disabled || authoringModeLockedReason !== undefined}
          lockedReason={authoringModeLockedReason}
        />
      )}

      <ToolGroupPicker
        groups={selection.toolGroups}
        onChange={onChange}
        writeScope={writeScopeSelected}
        authoringMode={selection.authoringMode}
        allowCreate={selection.allowCreate}
        offerSealed={offerSealed}
        kbs={live.flatMap((kb) => {
          const bits = selection.acl[kb.kbId] ?? [];
          return bits.length ? [{ name: kb.name, bits }] : [];
        })}
        createdKbBits={selection.allowCreate ? selection.createdKbBits : []}
        disabled={disabled}
      />

      <KbAccessPicker
        live={live}
        selection={draft}
        onChange={onChange}
        disabled={disabled}
        removalOnly={removalOnly}
      />

      <CreateCapabilityPicker
        selection={draft}
        onChange={onChange}
        writeScopeSelected={writeScopeSelected}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Which knowledge bases the credential reaches and with which permissions,
 * capped to the tool preset's ceiling. Each KB is its own fieldset listing
 * only the bits the user holds live; nothing starts checked.
 */
export function KbAccessPicker({
  live,
  selection: draft,
  onChange,
  disabled = false,
  removalOnly = {},
}: Pick<AclPickerProps, "live" | "selection" | "onChange" | "disabled" | "removalOnly">) {
  const { t } = useTranslation("settings");
  const base = useId();
  const selection = effectiveSelection(draft);
  const allowed = allowedKbBits(selection.toolGroups);
  const capped = allowed.length < KB_BITS.length;
  const id = (...parts: string[]) => `${base}-${parts.join("-")}`;
  const aclEmpty = Object.keys(selection.acl).length === 0;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{t("credentials.picker.kbsLegend")}</h3>
      <p className="text-sm text-muted-foreground">{t("credentials.picker.kbsHint")}</p>
      {capped && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("credentials.picker.presetCapsBits", {
            bits: allowed.map((bit) => t(`credentials.picker.bits.${bit}.label`)).join(", "),
          })}
        </p>
      )}
      {live.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("credentials.picker.noKbs")}</p>
      ) : (
        live.map((kb) => (
          <fieldset key={kb.kbId} className="min-w-0 space-y-2 rounded-md border p-3">
            <legend className="max-w-full truncate px-1 text-sm font-medium">{kb.name}</legend>
            {kb.bits.length > 0 && kb.bits.every((bit) => removalOnly[kb.kbId]?.includes(bit)) && (
              <p className="text-xs text-muted-foreground">
                {t("credentials.picker.kbUnavailable")}
              </p>
            )}
            {kb.bits
              .filter((bit) => allowed.includes(bit))
              .map((bit) => {
                const checked = (selection.acl[kb.kbId] ?? []).includes(bit);
                const stale = removalOnly[kb.kbId]?.includes(bit) ?? false;
                return (
                  <CheckRow
                    key={bit}
                    id={id("kb", kb.kbId, bit)}
                    checked={checked}
                    disabled={disabled || (stale && !checked)}
                    onToggle={() => onChange({ type: "toggleBit", kbId: kb.kbId, bit })}
                    label={t(`credentials.picker.bits.${bit}.label`)}
                    // Every KB repeats the same bit labels; name the KB too.
                    accessibleName={t("credentials.picker.kbBitName", {
                      kb: kb.name,
                      bit: t(`credentials.picker.bits.${bit}.label`),
                    })}
                    description={
                      stale
                        ? t("credentials.picker.removalOnly")
                        : t(`credentials.picker.bits.${bit}.description`)
                    }
                  />
                );
              })}
          </fieldset>
        ))
      )}
      {aclEmpty && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {t("credentials.picker.emptyAcl")}
        </p>
      )}
    </div>
  );
}

/** May the credential create knowledge bases, and what it gets on them (needs write access). */
export function CreateCapabilityPicker({
  selection: draft,
  onChange,
  writeScopeSelected = false,
  disabled = false,
}: Pick<AclPickerProps, "selection" | "onChange" | "writeScopeSelected" | "disabled">) {
  const { t } = useTranslation("settings");
  const base = useId();
  const selection = effectiveSelection(draft);
  const allowed = allowedKbBits(selection.toolGroups);
  const id = (...parts: string[]) => `${base}-${parts.join("-")}`;
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t("credentials.picker.createLegend")}</legend>
      <CheckRow
        id={id("create")}
        checked={selection.allowCreate}
        disabled={disabled || !writeScopeSelected}
        onToggle={() => onChange({ type: "setAllowCreate", value: !selection.allowCreate })}
        label={t("credentials.picker.allowCreate")}
        description={
          writeScopeSelected
            ? t("credentials.picker.allowCreateDescription")
            : t("credentials.picker.allowCreateNeedsWrite")
        }
      />
      {selection.allowCreate && (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t("credentials.picker.createdBitsLegend")}
          </legend>
          {allowed.map((bit: KbBit) => (
            <CheckRow
              key={bit}
              id={id("created", bit)}
              checked={selection.createdKbBits.includes(bit)}
              disabled={disabled}
              onToggle={() => onChange({ type: "toggleCreatedBit", bit })}
              label={t(`credentials.picker.bits.${bit}.label`)}
              description={t(`credentials.picker.bits.${bit}.description`)}
            />
          ))}
        </fieldset>
      )}
    </fieldset>
  );
}
