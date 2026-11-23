import {
  MCP_AUTHORING_MODES,
  type McpAuthoringMode,
} from "@knowledge-base/auth/mcp-authoring-mode";
import { useId } from "react";
import { useTranslation } from "react-i18next";

type AuthoringModePickerProps = {
  /** The chosen write mode; null until the user picks one (nothing is preselected). */
  value: McpAuthoringMode | null;
  onChange: (mode: McpAuthoringMode) => void;
  /** The modes on offer (a device login's ceiling); default: all three. */
  allowed?: readonly McpAuthoringMode[];
  disabled?: boolean;
  /** Why the choice is locked, shown under the options (e.g. temporary access). */
  lockedReason?: string;
};

/**
 * Write mode of a credential with write access: dreams only, direct edits
 * only, or both. A radio group with nothing selected at first; the surrounding
 * form keeps its submit disabled until a mode is chosen (`writeModeRequired`).
 * The server enforces the mode on every write; this only chooses it.
 */
export function AuthoringModePicker({
  value,
  onChange,
  allowed = MCP_AUTHORING_MODES,
  disabled = false,
  lockedReason,
}: AuthoringModePickerProps) {
  const { t } = useTranslation("settings");
  const base = useId();
  const offered = MCP_AUTHORING_MODES.filter((mode) => allowed.includes(mode));
  return (
    <fieldset className="min-w-0 space-y-2" aria-describedby={`${base}-hint`}>
      <legend className="text-sm font-medium">{t("credentials.writeMode.legend")}</legend>
      <p id={`${base}-hint`} className="text-sm text-muted-foreground">
        {t("credentials.writeMode.hint")}
      </p>
      <div role="radiogroup" aria-label={t("credentials.writeMode.legend")} className="space-y-1">
        {offered.map((mode) => {
          const id = `${base}-${mode}`;
          return (
            <label
              key={mode}
              htmlFor={id}
              className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md p-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
            >
              <input
                id={id}
                type="radio"
                name={`${base}-mode`}
                value={mode}
                checked={value === mode}
                disabled={disabled}
                onChange={() => onChange(mode)}
                aria-describedby={`${id}-desc`}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0 space-y-1">
                <span className="block text-sm leading-snug font-medium">
                  {t(`credentials.writeMode.modes.${mode}.label`)}
                </span>
                <span id={`${id}-desc`} className="block text-xs text-muted-foreground">
                  {t(`credentials.writeMode.modes.${mode}.description`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {offered.length < MCP_AUTHORING_MODES.length && (
        <p className="text-xs text-muted-foreground">{t("credentials.writeMode.limited")}</p>
      )}
      {lockedReason && <p className="text-xs text-muted-foreground">{lockedReason}</p>}
    </fieldset>
  );
}

/** A credential's write mode in words, for lists; null when read-only. */
export function AuthoringModeSummary({ mode }: { mode: McpAuthoringMode | null }) {
  const { t } = useTranslation("settings");
  if (mode === null) return null;
  return (
    <p className="text-xs">
      {t("credentials.writeMode.summary", {
        mode: t(`credentials.writeMode.modes.${mode}.label`),
      })}
    </p>
  );
}
