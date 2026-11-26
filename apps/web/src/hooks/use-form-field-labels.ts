import type { KeyValueEditorLabels } from "@knowledge-base/ui/components/key-value-editor";
import type { RangeFieldLabels } from "@knowledge-base/ui/components/range-field";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * Translated labels for the shared `RangeField` (`@knowledge-base/ui` ships no
 * strings). Pass a field-specific `limitMessage` to the field when "at most
 * N is available here" is too vague ("This host allows at most 16 GiB").
 */
export function useRangeFieldLabels(): RangeFieldLabels {
  // `t` changes identity when the language changes, which is what rebuilds these.
  const { t } = useTranslation("common");
  return useMemo(
    () => ({
      inputLabel: t("forms.range.inputLabel"),
      reset: t("forms.range.reset"),
      // The reason is a sentence of its own ("… at most 32 GiB"); the
      // translation adds its own full stop.
      adjusted: (value, reason) =>
        t("forms.range.adjusted", { value, reason: reason.replace(/[.!]$/, "") }),
      defaultState: (source) =>
        source ? t("forms.range.defaultFrom", { source }) : t("forms.range.default"),
      limit: (limit) => t("forms.range.limit", { limit }),
      errors: {
        notANumber: t("forms.range.errors.notANumber"),
        belowMin: (min) => t("forms.range.errors.belowMin", { min }),
        aboveMax: (max) => t("forms.range.errors.aboveMax", { max }),
        offStep: (step) => t("forms.range.errors.offStep", { step }),
      },
    }),
    [t],
  );
}

/** Translated labels for the shared `KeyValueEditor` (environment variables and the like). */
export function useKeyValueEditorLabels(): KeyValueEditorLabels {
  // `t` changes identity when the language changes, which is what rebuilds these.
  const { t } = useTranslation("common");
  return useMemo(
    () => ({
      key: t("forms.keyValue.key"),
      value: t("forms.keyValue.value"),
      keyInput: (row) => t("forms.keyValue.keyInput", { row }),
      valueInput: (key, row) =>
        key ? t("forms.keyValue.valueInput", { key }) : t("forms.keyValue.valueInputRow", { row }),
      unparsedLine: (row) => t("forms.keyValue.unparsedLine", { row }),
      maskedLines: (count) => t("forms.keyValue.maskedLines", { count }),
      add: t("forms.keyValue.add"),
      remove: (key, row) =>
        key ? t("forms.keyValue.remove", { key }) : t("forms.keyValue.removeRow", { row }),
      reveal: (key, row) =>
        key ? t("forms.keyValue.reveal", { key }) : t("forms.keyValue.revealRow", { row }),
      importFile: t("forms.keyValue.importFile"),
      mode: t("forms.keyValue.mode"),
      rowsMode: t("forms.keyValue.rowsMode"),
      textMode: t("forms.keyValue.textMode"),
      textHint: t("forms.keyValue.textHint"),
      secretTextHint: t("forms.keyValue.secretTextHint"),
      errors: {
        emptyKey: t("forms.keyValue.errors.emptyKey"),
        invalidKey: (key) => t("forms.keyValue.errors.invalidKey", { key }),
        duplicateKey: (key) => t("forms.keyValue.errors.duplicateKey", { key }),
        reservedKey: (key) => t("forms.keyValue.errors.reservedKey", { key }),
        parseLine: (line, code) =>
          t("forms.keyValue.errors.line", {
            line,
            reason: t(`forms.keyValue.errors.lineReasons.${code}`),
          }),
      },
    }),
    [t],
  );
}
