import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SearchCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

type LimitView = Awaited<ReturnType<AppRouterClient["settings"]["kbSearchAllLimit"]>>;

/** One whole-number field; the server refuses anything outside 1..max. */
export function SearchAllLimitForm({ view }: { view: LimitView }) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const save = useMutation(
    orpc.settings.setKbSearchAllLimit.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(orpc.settings.kbSearchAllLimit.queryKey(), next);
        toast.success(t("settings.searchAllLimit.saved"));
      },
    }),
  );
  const invalid = t("settings.searchAllLimit.invalid", { max: view.max });
  const form = useForm({
    defaultValues: { limit: String(view.limit) },
    validators: {
      onSubmit: z.object({
        limit: z
          .string()
          .trim()
          .regex(/^[1-9]\d?$/, invalid)
          .refine((value) => Number(value) <= view.max, invalid),
      }),
    },
    onSubmit: ({ value }) => save.mutate({ limit: Number(value.limit.trim()) }),
  });
  return (
    <form
      data-testid="search-all-limit-form"
      className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="limit">
        {(field) => (
          <TextField
            field={field}
            className="min-w-0 flex-1"
            label={t("settings.searchAllLimit.label")}
            description={t("settings.searchAllLimit.help", {
              max: view.max,
              default: view.default,
            })}
            autoComplete="off"
            inputMode="numeric"
            maxLength={2}
          />
        )}
      </form.Field>
      <Button type="submit" className="min-h-[44px]" disabled={save.isPending}>
        {save.isPending ? t("settings.searchAllLimit.saving") : t("settings.searchAllLimit.save")}
      </Button>
      {save.isError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {t("settings.searchAllLimit.failed")}
        </p>
      )}
    </form>
  );
}

/** Instance-admin limit for knowledge_search_all without kbIds ("every base I can read"). */
export function SearchAllLimitAdminPanel() {
  const { t } = useTranslation("admin");
  const { data, isPending, isError, refetch } = useQuery(
    orpc.settings.kbSearchAllLimit.queryOptions({ retry: false }),
  );
  return (
    <Card data-testid="search-all-limit-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SearchCheck className="size-5" />
          {t("settings.searchAllLimit.title")}
        </CardTitle>
        <CardDescription>{t("settings.searchAllLimit.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : isError || !data ? (
          <InlineRetry
            message={t("settings.searchAllLimit.loadFailed")}
            onRetry={() => refetch()}
          />
        ) : (
          <SearchAllLimitForm key={data.limit} view={data} />
        )}
      </CardContent>
    </Card>
  );
}
