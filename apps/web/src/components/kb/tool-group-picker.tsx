import {
  MCP_TOOL_GROUPS,
  MCP_TOOL_PRESETS,
  type McpToolGroup,
  type McpToolPreset,
  presetForGroups,
} from "@knowledge-base/auth/mcp-tool-groups";
import { Button } from "@knowledge-base/ui/components/button";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { CheckRow } from "@/components/kb/check-row";
import { SegmentedControl } from "@/components/segmented-control";
import type { KbBit, SelectionAction } from "@/hooks/use-mcp-consent";
import { previewTools } from "@/lib/mcp-tools";

type PresetChoice = McpToolPreset | "custom";
const PRESETS = Object.keys(MCP_TOOL_PRESETS) as McpToolPreset[];

/** The preset whose groups are exactly `groups`, else "custom". */
export function presetFor(groups: readonly string[]): PresetChoice {
  return presetForGroups(groups) ?? "custom";
}

type ToolGroupPickerProps = {
  groups: readonly McpToolGroup[];
  onChange: (action: SelectionAction) => void;
  /** Whether the credential carries `mcp:write` (tools that change data need it). */
  writeScope: boolean;
  allowCreate: boolean;
  /** OAuth connections never resolve sealed values, so they are never offered `sealed`. */
  offerSealed: boolean;
  /** The knowledge bases currently selected, with their selected (capped) permissions. */
  kbs: readonly { name: string; bits: readonly KbBit[] }[];
  /** Permissions on knowledge bases the credential creates (empty unless allowed). */
  createdKbBits: readonly KbBit[];
  disabled: boolean;
};

/**
 * Which tools a connection may call: a preset (Read, Propose edits, Direct
 * edits) or, under "Advanced", the groups themselves, with a live preview of
 * the tools and knowledge bases the agent will see. The server enforces the
 * groups on every call; this only describes them.
 */
export function ToolGroupPicker({
  groups,
  onChange,
  writeScope,
  allowCreate,
  offerSealed,
  kbs,
  createdKbBits,
  disabled,
}: ToolGroupPickerProps) {
  const { t } = useTranslation("settings");
  const base = useId();
  const preset = presetFor(groups);
  const [advanced, setAdvanced] = useState(preset === "custom");
  const preview = previewTools({
    groups,
    writeScope,
    allowCreate,
    kbBits: kbs.map((kb) => kb.bits),
    createdKbBits,
  });
  const kbNames = kbs.map((kb) => kb.name);
  const offered = MCP_TOOL_GROUPS.filter((group) => offerSealed || group !== "sealed");

  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-medium">{t("credentials.picker.toolsLegend")}</legend>
      <p className="text-sm text-muted-foreground">{t("credentials.picker.toolsHint")}</p>
      <SegmentedControl<PresetChoice>
        value={preset}
        ariaLabel={t("credentials.picker.toolsLegend")}
        items={[
          ...PRESETS.map((value) => ({
            value,
            label: t(`credentials.picker.presets.${value}.label`),
          })),
          { value: "custom" as const, label: t("credentials.picker.presets.custom.label") },
        ]}
        onChange={(next) => {
          if (disabled) return;
          if (next === "custom") setAdvanced(true);
          else onChange({ type: "setToolGroups", groups: MCP_TOOL_PRESETS[next] });
        }}
      />
      <p className="text-sm text-muted-foreground">
        {t(`credentials.picker.presets.${preset}.description`)}
      </p>
      <Button
        type="button"
        variant="ghost"
        className="min-h-[44px] px-2"
        aria-expanded={advanced}
        aria-controls={`${base}-advanced`}
        onClick={() => setAdvanced((open) => !open)}
      >
        {t(advanced ? "credentials.picker.hideAdvanced" : "credentials.picker.showAdvanced")}
      </Button>
      {advanced && (
        <fieldset id={`${base}-advanced`} className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t("credentials.picker.groupsLegend")}
          </legend>
          {offered.map((group) => (
            <CheckRow
              key={group}
              id={`${base}-group-${group}`}
              checked={groups.includes(group)}
              disabled={disabled}
              onToggle={() => onChange({ type: "toggleToolGroup", group })}
              label={t(`credentials.picker.groups.${group}.label`)}
              description={t(`credentials.picker.groups.${group}.description`)}
            />
          ))}
        </fieldset>
      )}
      <section
        aria-label={t("credentials.picker.previewTitle")}
        className="min-w-0 space-y-2 rounded-md border border-dashed p-3 text-sm"
      >
        <h4 className="font-medium">{t("credentials.picker.previewTitle")}</h4>
        {preview.tools.length === 0 ? (
          <p className="text-muted-foreground">
            {/* The groups may have tools the agent can't use yet; the notes say why. */}
            {preview.needWrite.length + preview.noEligibleKb.length > 0
              ? t("credentials.picker.previewNoUsableTools")
              : t("credentials.picker.previewNoTools")}
          </p>
        ) : (
          <ul className="space-y-0.5 font-mono text-xs break-words">
            {preview.tools.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {t("credentials.picker.previewSupporting", { tools: preview.supporting.join(", ") })}
        </p>
        <p className="text-xs break-words">
          {kbNames.length === 0
            ? t("credentials.picker.previewNoKbs")
            : t("credentials.picker.previewKbs", { names: kbNames.join(", ") })}
          {allowCreate ? ` ${t("credentials.picker.previewCreated")}` : ""}
        </p>
        {preview.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {t(`credentials.picker.previewNotes.${note}`, {
              tools: (note === "noEligibleKb" ? preview.noEligibleKb : preview.needWrite).join(
                ", ",
              ),
            })}
          </p>
        ))}
      </section>
    </fieldset>
  );
}
