import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Capability } from "@/hooks/use-kb-editor";

/** The five KB permissions, in the order every picker shows them. */
export const PERMISSION_BITS: readonly Capability[] = [
  "read",
  "propose",
  "write",
  "review",
  "manage",
];

/**
 * One permission's one-line meaning. Members and API keys grant the same five
 * permissions, so both read the one wording kept with the API-key picker.
 */
const permissionDescriptionKey = (bit: string) =>
  `settings:credentials.picker.bits.${bit}.description`;

/**
 * The member permission checkboxes (invite form and edit sheet): each one
 * with its meaning, then the note on what the server adds by implication.
 * A box is named by the permission alone and described by its meaning.
 */
export function PermissionChoices({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly Capability[];
  onChange: (next: Capability[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["kb", "settings"]);
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <ul className="flex flex-col">
        {PERMISSION_BITS.map((bit) => (
          <li key={bit}>
            <label className="flex min-h-[44px] items-start gap-3 py-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`permission-${bit}`}
                className="mt-0.5 size-4 shrink-0"
                checked={value.includes(bit)}
                disabled={disabled}
                aria-labelledby={`${id}-${bit}-label`}
                aria-describedby={`${id}-${bit}`}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value.filter((b) => b !== bit), bit]
                      : value.filter((b) => b !== bit),
                  )
                }
              />
              <span className="min-w-0 space-y-0.5">
                <span id={`${id}-${bit}-label`} className="block font-medium">
                  {t(`kb:settings.bits.${bit}`)}
                </span>
                <span id={`${id}-${bit}`} className="block text-xs text-muted-foreground">
                  {t(permissionDescriptionKey(bit))}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t("kb:settings.members.permissionsImplied")}</p>
    </div>
  );
}

/** The permissions someone will have, in words (the invitation preview). */
export function PermissionSummary({ bits }: { bits: readonly string[] }) {
  const { t } = useTranslation(["kb", "settings"]);
  return (
    <ul data-testid="permission-summary" className="space-y-2 text-sm">
      {PERMISSION_BITS.filter((bit) => bits.includes(bit)).map((bit) => (
        <li key={bit} className="space-y-0.5">
          <span className="block font-medium">{t(`kb:settings.bits.${bit}`)}</span>
          <span className="block text-xs text-muted-foreground">
            {t(permissionDescriptionKey(bit))}
          </span>
        </li>
      ))}
    </ul>
  );
}
