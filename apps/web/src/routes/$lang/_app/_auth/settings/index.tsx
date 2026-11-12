import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { Checkbox } from "@knowledge-base/ui/components/checkbox";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import z from "zod";
import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";
import { QueryBoundary } from "@/components/query-boundary";
import { authClient } from "@/lib/auth-client";
import { pageHead } from "@/lib/page-title";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/settings/")({
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t("settings:navProfile"),
      match.context.i18n.t("nav:items.settings"),
    ),
  component: ProfileSettings,
});

function buildProfileSchema() {
  return z.object({
    name: z.string().min(2),
  });
}

function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

function ProfileSettings() {
  const { session } = Route.useRouteContext();
  const { t } = useTranslation(["settings", "auth", "common", "consent"]);
  const queryClient = useQueryClient();
  const notificationPrefs = useQuery({
    ...orpc.settings.myNotificationPreferences.queryOptions(),
    enabled: hasAdminRole(session.user.role),
  });
  const updateNotificationPrefs = useMutation(
    orpc.settings.updateMyNotificationPreferences.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.settings.myNotificationPreferences.queryKey(),
        });
        toast.success(t("settings:profile.notificationsSaved"));
      },
      onError: () => {
        toast.error(t("settings:profile.notificationsSaveError"));
      },
    }),
  );

  const form = useForm({
    defaultValues: {
      name: session.user.name || "",
    },
    onSubmit: async ({ value }) => {
      const result = await authClient.updateUser({
        name: value.name,
      });
      if (result.error) {
        console.error("[settings.updateUser]", result.error);
        toast.error(friendly(result.error, t("settings:profile.saveError")));
        return;
      }
      toast.success(t("settings:profile.saved"));
    },
    validators: {
      onSubmit: buildProfileSchema(),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:profile.title")}</CardTitle>
        <CardDescription>{t("settings:profile.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="profile-email">{t("auth:fields.email")}</Label>
            <Input
              id="profile-email"
              type="email"
              value={session.user.email}
              disabled
              aria-describedby="profile-email-hint"
            />
            <p id="profile-email-hint" className="text-xs text-muted-foreground">
              {t("settings:profile.emailReadonly")}
            </p>
          </div>

          <form.Field name="name">
            {(field) => (
              <TextField
                field={field}
                label={t("auth:fields.name")}
                inputMode="text"
                autoComplete="name"
              />
            )}
          </form.Field>

          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button
                type="submit"
                className="max-md:min-h-11"
                disabled={!canSubmit || isSubmitting}
              >
                {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
              </Button>
            )}
          </form.Subscribe>
        </form>

        {hasAdminRole(session.user.role) ? (
          <div className="mt-6 border-t pt-6">
            <QueryBoundary
              query={notificationPrefs}
              skeleton={<Skeleton className="h-16 w-full" />}
            >
              {(preferences) => (
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="operational-alerts"
                    checked={preferences.operationalAlerts}
                    disabled={updateNotificationPrefs.isPending}
                    onCheckedChange={(checked) => {
                      updateNotificationPrefs.mutate({ operationalAlerts: checked === true });
                    }}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="operational-alerts">
                      {t("settings:profile.operationalAlerts")}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t("settings:profile.operationalAlertsDescription")}
                    </p>
                  </div>
                </div>
              )}
            </QueryBoundary>
          </div>
        ) : null}

        <div className="mt-6 space-y-2 border-t pt-6">
          <Label>{t("consent:preferences.title")}</Label>
          <p className="text-muted-foreground text-sm">{t("consent:preferences.description")}</p>
          <ConsentPreferencesButton />
        </div>
      </CardContent>
    </Card>
  );
}
