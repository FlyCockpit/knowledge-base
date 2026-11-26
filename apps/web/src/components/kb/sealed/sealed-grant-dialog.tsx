import { Button } from "@knowledge-base/ui/components/button";
import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { SelectItem } from "@knowledge-base/ui/components/select";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { SelectField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import { ControlError, describeControlError } from "@/components/kb/profile-panel";
import { LoadMore } from "@/components/load-more";
import { useKbAccessLoss, useRetireSealedOnDenied } from "@/hooks/use-kb-editor";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";
import type { SealedKbLike, SealedTarget } from "./sealed-add-secret-dialog";
import {
  formatDate,
  type GrantBlocker,
  grantAttemptSignature,
  grantBlocker,
  grantPayload,
  groupConsumers,
  manualKey,
  nextGrantAttempt,
  PUBLIC_KEY,
  SEALED_DEFAULT_EXPIRY,
  SEALED_EXPIRY_CHOICES,
  type SealedConsumer,
  type SealedConsumerProblem,
  type SealedExpiryChoice,
  type SealedKey,
  sealedExpiryFromChoice,
  shortKeyId,
  switchConsumerDraft,
  tokenEndsFirst,
  UUID,
} from "./sealed-logic";

const KEY_FILE_EXAMPLE = '{"id":"<new UUID>","private_key":[<32 random bytes as numbers>]}';
const LOGIN_COMMAND = "kb login --recipient-key-file /path/to/recipient.json";

function ProblemHelp({ problem, lang }: { problem: SealedConsumerProblem; lang: string }) {
  const { t } = useTranslation("kb");
  return (
    <span className="block text-xs text-destructive">
      {t(`settings.sealed.grantDialog.problems.${problem}`)}{" "}
      {problem === "holder_not_eligible" || problem === "holder_inactive" ? null : (
        <Link
          to="/$lang/settings/mcp"
          params={{ lang }}
          className="inline-flex min-h-[44px] items-center underline underline-offset-4 sm:min-h-0"
        >
          {t("settings.sealed.grantDialog.openTokens")}
        </Link>
      )}
    </span>
  );
}

/** The pickable tokens, own first, each with what stops it working (if anything). */
export function SealedConsumerList({
  consumers,
  selectedId,
  onSelect,
  lang,
  name,
}: {
  consumers: readonly SealedConsumer[];
  selectedId: string;
  onSelect: (consumerId: string) => void;
  lang: string;
  /** The radio group's form name. */
  name: string;
}) {
  const { t } = useTranslation("kb");
  const groups = groupConsumers(consumers);
  const section = (title: string, items: SealedConsumer[]) =>
    items.length === 0 ? null : (
      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{title}</legend>
        {items.map((consumer) => {
          const blocked = consumer.problems.length > 0;
          return (
            <label
              key={consumer.consumerId}
              data-testid="sealed-consumer"
              data-consumer-id={consumer.consumerId}
              data-blocked={blocked ? "true" : "false"}
              className="flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed"
            >
              <input
                type="radio"
                name={name}
                value={consumer.consumerId}
                checked={selectedId === consumer.consumerId}
                disabled={blocked}
                onChange={() => onSelect(consumer.consumerId)}
                className="mt-1 size-4 shrink-0"
              />
              <span className="min-w-0 space-y-0.5 text-sm">
                <span
                  className={`block break-words font-medium ${blocked ? "text-muted-foreground" : ""}`}
                >
                  {consumer.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {consumer.holder.kind === "member"
                    ? `${t("settings.sealed.grantDialog.memberToken", { name: consumer.holder.name })} · `
                    : ""}
                  {consumer.expiresAt
                    ? t("settings.sealed.grantDialog.tokenExpires", {
                        date: formatDate(consumer.expiresAt, lang),
                      })
                    : t("settings.sealed.grantDialog.tokenNoExpiry")}
                </span>
                {/* One reason is enough; the two read-access ones say the same thing. */}
                {consumer.problems[0] && <ProblemHelp problem={consumer.problems[0]} lang={lang} />}
              </span>
            </label>
          );
        })}
      </fieldset>
    );
  return (
    <div className="min-w-0 space-y-4">
      {section(t("settings.sealed.grantDialog.own"), groups.own)}
      {section(t("settings.sealed.grantDialog.members"), groups.members)}
    </div>
  );
}

/** What to do when nothing can be picked: create a token or sign in with the CLI. */
export function SealedNoConsumers({ lang }: { lang: string }) {
  const { t } = useTranslation("kb");
  return (
    <div data-testid="sealed-no-consumers" className="min-w-0 space-y-2 text-sm">
      <p className="font-medium">{t("settings.sealed.grantDialog.empty")}</p>
      <p className="text-muted-foreground">{t("settings.sealed.grantDialog.emptyHow")}</p>
      <CodeSnippet code={LOGIN_COMMAND} />
      <Link
        to="/$lang/settings/mcp"
        params={{ lang }}
        className="inline-flex min-h-[44px] items-center underline underline-offset-4"
      >
        {t("settings.sealed.grantDialog.openTokens")}
      </Link>
    </div>
  );
}

/** The registered key, or the steps to register one. */
export function SealedKeyFound({ consumer }: { consumer: SealedConsumer }) {
  const { t } = useTranslation("kb");
  const key = consumer.recipientKey;
  if (!key) return null;
  return (
    <div
      data-testid="sealed-key-found"
      data-key-id={key.recipientKeyId}
      role="status"
      className="flex min-w-0 items-start gap-2 rounded-md border p-3 text-sm"
    >
      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
      <span className="min-w-0 space-y-0.5">
        <span className="block font-medium">
          {t("settings.sealed.grantDialog.key.found")} ·{" "}
          {t("settings.sealed.grantDialog.key.shortId", { id: shortKeyId(key.recipientKeyId) })}
        </span>
        <span className="block text-xs text-muted-foreground">
          {key.source === "device"
            ? t("settings.sealed.grantDialog.key.fromDevice")
            : t("settings.sealed.grantDialog.key.fromApproved")}
        </span>
      </span>
    </div>
  );
}

export function SealedKeySteps() {
  const { t } = useTranslation("kb");
  return (
    <div data-testid="sealed-key-steps" className="min-w-0 space-y-2 text-sm">
      <p className="font-medium">{t("settings.sealed.grantDialog.key.missing")}</p>
      <ol className="min-w-0 list-decimal space-y-2 pl-5">
        <li className="min-w-0 space-y-1">
          <span>{t("settings.sealed.grantDialog.key.step1")}</span>
          <CodeSnippet code={KEY_FILE_EXAMPLE} />
        </li>
        <li className="min-w-0 space-y-1">
          <span>{t("settings.sealed.grantDialog.key.step2")}</span>
          <CodeSnippet code={LOGIN_COMMAND} />
        </li>
        <li>{t("settings.sealed.grantDialog.key.step3")}</li>
      </ol>
    </div>
  );
}

function ExpiryLabel({ choice }: { choice: SealedExpiryChoice }) {
  const { t } = useTranslation("kb");
  return choice === "custom"
    ? t("settings.sealed.grantDialog.expiry.custom")
    : choice === "365"
      ? t("settings.sealed.grantDialog.expiry.year")
      : t("settings.sealed.grantDialog.expiry.days", { count: Number(choice) });
}

function GrantBody({
  kb,
  target,
  lang,
  onDone,
  onGranted,
  onDenied,
  onReadDenied,
}: {
  kb: SealedKbLike;
  target: SealedTarget;
  lang: string;
  /** The token list was refused: the panel retires all sealed UI and data. */
  onReadDenied?: () => void;
  onDone: () => void;
  onGranted: () => void;
  onDenied?: () => void;
}) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const consumersQuery = useInfiniteQuery(
    orpc.kbSealed.consumers.infiniteOptions({
      input: (cursor: string | null) => ({ kbId: kb.id, limit: 50, cursor: cursor ?? undefined }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
      gcTime: 0,
    }),
  );
  const { data, error, isPending, isError, hasNextPage, isFetchingNextPage } = consumersQuery;
  // A refused read hides the cached token list and re-checks the KB permission.
  useKbAccessLoss(kb.id, [error]);
  const readDenied = isQueryAccessError(error);
  useRetireSealedOnDenied(kb.id, readDenied, onReadDenied);
  const consumers = readDenied ? [] : (data?.pages.flatMap((page) => page.items) ?? []);
  const pending = useRef<{ signature: string; payload: ReturnType<typeof grantPayload> } | null>(
    null,
  );
  const grant = useMutation(
    orpc.kbSealed.grant.mutationOptions({
      onSuccess: () => {
        if (!session.current) return;
        pending.current = null;
        attempt.renew();
        onGranted();
        onDone();
      },
      onError: (error) => {
        if (session.current && describeControlError(error) === "denied") onDenied?.();
      },
    }),
  );
  const form = useForm({
    defaultValues: {
      consumerId: "",
      keyId: "",
      publicKey: "",
      expiry: SEALED_DEFAULT_EXPIRY as SealedExpiryChoice,
      customDate: "",
    },
    onSubmit: ({ value }) => {
      // An unchanged retry resends the exact first request (same absolute end
      // date and idempotency key) so a committed-but-unacknowledged approval
      // replays its receipt; any change starts a new operation.
      // The attempt's identity includes the key it resolves to, so a retry
      // never sends a key other than the one now shown.
      const shown = derive(value, new Date());
      const signature = grantAttemptSignature(value, shown.key);
      const next = nextGrantAttempt(pending.current, signature, (renewKey) => {
        const state = derive(value, new Date());
        if (state.blocker || !state.consumer || !state.key || !state.expiresAt) return null;
        return grantPayload({
          kbId: kb.id,
          reference: target.reference,
          consumer: state.consumer,
          key: state.key,
          expiresAt: state.expiresAt,
          idempotencyKey: renewKey ? attempt.renew() : attempt.key,
        });
      });
      if (!next) return;
      pending.current = next;
      grant.mutate(next.payload);
    },
  });
  type Values = typeof form.state.values;
  function derive(value: Values, now: Date) {
    const consumer = consumers.find((c) => c.consumerId === value.consumerId) ?? null;
    const key: SealedKey | null =
      consumer?.recipientKey ?? (consumer ? manualKey(value.keyId, value.publicKey) : null);
    const expiresAt = sealedExpiryFromChoice(value.expiry, value.customDate, now);
    const blocker: GrantBlocker | null = grantBlocker({
      consumer,
      key,
      expiresAt,
      now,
      existing: target.grants,
    });
    return { consumer, key, expiresAt, blocker };
  }

  return (
    <form
      className="min-w-0 space-y-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">{t("settings.sealed.grantDialog.tokens")}</p>
        {readDenied ? (
          <p
            data-testid="sealed-consumers-denied"
            role="alert"
            className="text-sm text-destructive"
          >
            {t("settings.sealed.list.denied")}
          </p>
        ) : isPending ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : isError && consumers.length === 0 ? (
          <InlineRetry
            message={t("settings.sealed.grantDialog.loadError")}
            onRetry={() => consumersQuery.refetch()}
          />
        ) : consumers.length === 0 ? (
          <SealedNoConsumers lang={lang} />
        ) : (
          <form.Field name="consumerId">
            {(field) => (
              <SealedConsumerList
                consumers={consumers}
                selectedId={field.state.value}
                onSelect={(id) => {
                  const next = switchConsumerDraft(form.state.values, id);
                  if (next === form.state.values) return;
                  form.setFieldValue("keyId", next.keyId);
                  form.setFieldValue("publicKey", next.publicKey);
                  field.handleChange(id);
                }}
                lang={lang}
                name="sealed-consumer"
              />
            )}
          </form.Field>
        )}
        {isError && consumers.length > 0 && (
          <InlineRetry
            message={t("settings.sealed.grantDialog.loadError")}
            onRetry={() =>
              consumersQuery.isFetchNextPageError
                ? consumersQuery.fetchNextPage()
                : consumersQuery.refetch()
            }
          />
        )}
        <LoadMore
          onLoadMore={() => consumersQuery.fetchNextPage()}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          label={t("settings.sealed.grantDialog.loadMore")}
        />
      </div>

      <form.Subscribe selector={(state) => state.values.consumerId}>
        {(consumerId) => {
          const consumer = consumers.find((c) => c.consumerId === consumerId);
          if (!consumer || consumer.problems.length > 0) return null;
          if (consumer.recipientKey) return <SealedKeyFound consumer={consumer} />;
          return (
            <div className="min-w-0 space-y-3">
              <SealedKeySteps />
              <details data-testid="sealed-manual-key" className="min-w-0 rounded-md border p-3">
                <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-medium">
                  {t("settings.sealed.grantDialog.key.manual")}
                </summary>
                <div className="min-w-0 space-y-3 pt-2">
                  <p className="text-xs text-muted-foreground">
                    {t("settings.sealed.grantDialog.key.manualHint")}
                  </p>
                  <form.Field name="keyId">
                    {(field) => (
                      <div className="space-y-1">
                        <TextField
                          field={field}
                          label={t("settings.sealed.grantDialog.key.keyId")}
                          autoComplete="off"
                          inputMode="text"
                          inputClassName="font-mono"
                          maxLength={36}
                        />
                        {field.state.value.trim() !== "" &&
                          !UUID.test(field.state.value.trim().toLowerCase()) && (
                            <p role="alert" className="text-sm text-destructive">
                              {t("settings.sealed.grantDialog.key.keyIdInvalid")}
                            </p>
                          )}
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="publicKey">
                    {(field) => (
                      <div className="space-y-1">
                        <TextField
                          field={field}
                          label={t("settings.sealed.grantDialog.key.publicKey")}
                          autoComplete="off"
                          inputMode="text"
                          inputClassName="font-mono"
                          maxLength={44}
                        />
                        {field.state.value.trim() !== "" &&
                          !PUBLIC_KEY.test(field.state.value.trim()) && (
                            <p role="alert" className="text-sm text-destructive">
                              {t("settings.sealed.grantDialog.key.publicKeyInvalid")}
                            </p>
                          )}
                      </div>
                    )}
                  </form.Field>
                </div>
              </details>
            </div>
          );
        }}
      </form.Subscribe>

      <form.Field name="expiry">
        {(field) => (
          <SelectField
            field={field}
            label={t("settings.sealed.grantDialog.expiry.label")}
            valueLabel={<ExpiryLabel choice={field.state.value} />}
          >
            {SEALED_EXPIRY_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice} className="min-h-[44px]">
                <ExpiryLabel choice={choice} />
              </SelectItem>
            ))}
          </SelectField>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.expiry}>
        {(expiry) =>
          expiry === "custom" ? (
            <form.Field name="customDate">
              {(field) => (
                <TextField
                  field={field}
                  type="datetime-local"
                  label={t("settings.sealed.grantDialog.expiry.customLabel")}
                  autoComplete="off"
                  inputMode="none"
                />
              )}
            </form.Field>
          ) : null
        }
      </form.Subscribe>

      <form.Subscribe selector={(state) => state.values}>
        {(values) => {
          const state = derive(values, new Date());
          return (
            <div className="min-w-0 space-y-3">
              {values.expiry === "custom" && values.customDate !== "" && !state.expiresAt && (
                <p role="alert" className="text-sm text-destructive">
                  {t("settings.sealed.grantDialog.expiry.invalid")}
                </p>
              )}
              {state.consumer?.expiresAt && tokenEndsFirst(state.consumer, state.expiresAt) && (
                <p data-testid="sealed-token-ends-first" role="status" className="text-sm">
                  {t("settings.sealed.grantDialog.expiry.tokenFirst", {
                    date: formatDate(state.consumer.expiresAt, lang),
                  })}
                </p>
              )}
              <ControlError error={grant.error} testId="sealed-error" />
              {state.blocker && (
                <p
                  data-testid="sealed-grant-blocker"
                  data-blocker={state.blocker}
                  className="text-sm text-muted-foreground"
                >
                  {t(`settings.sealed.grantDialog.blockers.${state.blocker}`)}
                </p>
              )}
              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button type="button" variant="outline" className="min-h-[44px]" onClick={onDone}>
                  {t("settings.sealed.grantDialog.cancel")}
                </Button>
                <Button
                  type="submit"
                  data-testid="sealed-grant"
                  className="min-h-[44px]"
                  disabled={state.blocker !== null || grant.isPending}
                >
                  {grant.isPending
                    ? t("settings.sealed.grantDialog.submitting")
                    : t("settings.sealed.grantDialog.submit")}
                </Button>
              </DialogFooter>
            </div>
          );
        }}
      </form.Subscribe>
    </form>
  );
}

/**
 * Give one token access to one value: pick the token, its key is filled in
 * from what it registered, choose when access ends. A token that could not
 * use the value is refused here, before anything is sent.
 */
export function SealedGrantDialog({
  kb,
  target,
  lang,
  onOpenChange,
  onGranted,
  onDenied,
  onReadDenied,
}: {
  kb: SealedKbLike;
  target: SealedTarget | null;
  lang: string;
  onReadDenied?: () => void;
  onOpenChange: (open: boolean) => void;
  onGranted: () => void;
  onDenied?: () => void;
}) {
  const { t } = useTranslation("kb");
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="sealed-grant-dialog"
        className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="break-words">
            {t("settings.sealed.grantDialog.title", {
              name: target?.label ?? t("settings.sealed.list.unnamed"),
            })}
          </DialogTitle>
          <DialogDescription>{t("settings.sealed.grantDialog.description")}</DialogDescription>
        </DialogHeader>
        {target && (
          <GrantBody
            kb={kb}
            target={target}
            lang={lang}
            onDone={() => onOpenChange(false)}
            onGranted={onGranted}
            onDenied={onDenied}
            onReadDenied={onReadDenied}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
