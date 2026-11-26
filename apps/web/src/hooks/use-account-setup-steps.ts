import { isAdminRole } from "@knowledge-base/auth/roles";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { GettingStartedStep } from "@/components/home/getting-started";
import { orpc } from "@/utils/orpc";

type SetupUser = { role?: string | null };

/**
 * The account step of the getting-started checklist, with its done state read
 * from real data:
 *
 * - **Invite someone** (admins only): done once the server has more than one
 *   account, read with the admin `users.list` at `limit: 1` (two rows at
 *   most; `nextCursor` set means a second account exists). Sharing a
 *   knowledge base needs the other person's account first, so on a fresh
 *   server this is the step that makes sharing possible. If that read fails
 *   (an admin locked out by forced 2FA, say) the step is left out rather than
 *   shown with a guess.
 *
 * The template's two-factor step is left out: this app already prompts for
 * two-factor where its policy wants it (`TwoFactorNudge`, the forced-2FA
 * enrollment in the `_auth` layout), and a second prompt would disagree with
 * that policy for roles it does not cover.
 *
 * `isPending` stays true until the read behind it answered, so the checklist
 * mounts once, already right. `enabled: false` (the checklist is hidden)
 * skips the read. docs/ui.md § The signed-in home.
 */
export function useAccountSetupSteps({
  lang,
  user,
  enabled = true,
}: {
  lang: string;
  user: SetupUser;
  enabled?: boolean;
}): { steps: GettingStartedStep[]; isPending: boolean } {
  const { t } = useTranslation("common");
  const isAdmin = isAdminRole(user.role);
  const users = useQuery({
    ...orpc.users.list.queryOptions({ input: { limit: 1 } }),
    enabled: enabled && isAdmin,
    // A failure only drops the step; no toast for a convenience read.
    meta: { skipGlobalErrorToast: true },
    retry: false,
  });

  const steps: GettingStartedStep[] = [];
  if (isAdmin && users.isSuccess) {
    steps.push({
      id: "invite",
      title: t("gettingStarted.steps.invite.title"),
      description: t("gettingStarted.steps.invite.description"),
      done: users.data.nextCursor !== null,
      action: {
        label: t("gettingStarted.steps.invite.action"),
        link: { to: "/$lang/admin/users", params: { lang } },
      },
    });
  }

  return { steps, isPending: enabled && isAdmin && users.isPending };
}
