import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Label } from "@knowledge-base/ui/components/label";
import { TextareaField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Help } from "@/components/help";
import { ControlError, describeControlError } from "@/components/kb/profile-panel";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { useTransientSecretMutation } from "@/hooks/use-transient-secret-mutation";
import { orpc } from "@/utils/orpc";

type KbLike = {
  id: string;
  capabilities: readonly string[];
  sealedNamespace: string;
  isOwner: boolean;
};

/** CONTRACT: sealed plaintext is at most 16 KiB of UTF-8. */
export const SEALED_PLAINTEXT_MAX_BYTES = 16384;
export const utf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFERENCE = new RegExp(`^\\{\\{sealed:v1:knowledge_base:${UUID_PART}:${UUID_PART}\\}\\}$`);
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
/** Remote consumers are PATs, including CLI device-flow PATs. */
const CONSUMER_KINDS = ["pat"] as const;
type ConsumerKind = (typeof CONSUMER_KINDS)[number];

export type SealedGrantDraft = {
  reference: string;
  consumerKind: string;
  consumerId: string;
  recipientKeyId: string;
  recipientPublicKey: string;
  expiresAt: string;
};
export type SealedGrantIssue = keyof SealedGrantDraft;

/**
 * A grant names exactly one record and exactly one recipient key; anything
 * that is not a single exact identifier (wildcards, blanks) is rejected here
 * and again by the server.
 */
export function sealedGrantIssues(draft: SealedGrantDraft, now: number): SealedGrantIssue[] {
  const issues: SealedGrantIssue[] = [];
  if (!REFERENCE.test(draft.reference.trim())) issues.push("reference");
  const kind = CONSUMER_KINDS.find((k) => k === draft.consumerKind);
  if (!kind) issues.push("consumerKind");
  if (!UUID.test(draft.consumerId)) issues.push("consumerId");
  if (!UUID.test(draft.recipientKeyId.trim())) issues.push("recipientKeyId");
  if (!PUBLIC_KEY.test(draft.recipientPublicKey.trim())) issues.push("recipientPublicKey");
  const expires = Date.parse(draft.expiresAt);
  if (Number.isNaN(expires) || expires <= now) issues.push("expiresAt");
  return issues;
}

/** Sealed controls need `manage`; the server additionally requires the exact owner. */
/** Sealed control is exact-owner only: a manager who is not the owner never sees it. */
export function sealedControls(bits: readonly string[], isOwner: boolean): { visible: boolean } {
  return { visible: isOwner && bits.includes("manage") };
}

export function SealedReferenceReveal({ reference }: { reference: string }) {
  const { t } = useTranslation("kb");
  return (
    <div
      data-testid="sealed-reference"
      data-reference={reference}
      role="status"
      className="space-y-2 text-sm"
    >
      <p className="font-medium">{t("settings.sealed.reference")}</p>
      <CopyField value={reference} copyLabel={t("settings.sealed.copyReference")} />
      <p className="text-xs text-muted-foreground">{t("settings.sealed.referenceHint")}</p>
    </div>
  );
}

type Denied = { onDenied?: () => void };
/** A refused sealed action re-checks the KB permission; it never clears data itself. */
const deniedHandler = (onDenied: Denied["onDenied"]) => (error: unknown) => {
  if (describeControlError(error) === "denied") onDenied?.();
};

function EnrollForm({
  kb,
  onEnrolled,
  onDenied,
}: { kb: KbLike; onEnrolled: (reference: string) => void } & Denied) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const draft = useRef(0);
  const submittedDraft = useRef(0);
  const [reference, setReference] = useState<string | null>(null);
  const enroll = useTransientSecretMutation(orpc.kbSealed.enroll.mutationOptions(), {
    onSuccess: (result) => {
      attempt.renew();
      setReference(result.reference);
      onEnrolled(result.reference);
      if (draft.current === submittedDraft.current) form.reset();
      enroll.reset();
    },
    onError: deniedHandler(onDenied),
  });
  const form = useForm({
    defaultValues: { plaintext: "" },
    onSubmit: ({ value }) => {
      const bytes = utf8ByteLength(value.plaintext);
      if (bytes === 0 || bytes > SEALED_PLAINTEXT_MAX_BYTES) return;
      setReference(null);
      const idempotencyKey =
        draft.current === submittedDraft.current ? attempt.key : attempt.renew();
      const submitted = enroll.mutate({
        kbId: kb.id,
        namespace: kb.sealedNamespace,
        plaintext: value.plaintext,
        idempotencyKey,
      });
      if (submitted) submittedDraft.current = draft.current;
    },
  });
  return (
    <form
      className="min-w-0 space-y-3"
      onChange={() => {
        draft.current += 1;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="plaintext">
        {(field) => {
          const bytes = utf8ByteLength(field.state.value);
          return (
            <TextareaField
              field={field}
              label={t("settings.sealed.plaintext")}
              autoComplete="off"
              spellCheck={false}
              rows={3}
              description={
                bytes > SEALED_PLAINTEXT_MAX_BYTES
                  ? t("settings.sealed.tooLong")
                  : t("settings.sealed.bytes", { count: bytes, max: SEALED_PLAINTEXT_MAX_BYTES })
              }
            />
          );
        }}
      </form.Field>
      <ControlError error={enroll.error} testId="sealed-error" />
      <Button
        type="submit"
        data-testid="sealed-enroll"
        className="min-h-[44px]"
        disabled={enroll.isPending}
      >
        {enroll.isPending ? t("settings.sealed.enrolling") : t("settings.sealed.enroll")}
      </Button>
      {reference && <SealedReferenceReveal reference={reference} />}
    </form>
  );
}

const defaultExpiry = () => {
  const date = new Date(Date.now() + 30 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function GrantForm({
  kb,
  lastReference,
  onDenied,
}: { kb: KbLike; lastReference: string | null } & Denied) {
  const { t } = useTranslation("kb");
  const kindId = useId();
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const [issues, setIssues] = useState<SealedGrantIssue[]>([]);
  const grant = useMutation(
    orpc.kbSealed.grant.mutationOptions({
      onSuccess: () => {
        if (session.current) attempt.renew();
      },
      onError: (error) => {
        if (session.current) deniedHandler(onDenied)(error);
      },
    }),
  );
  const form = useForm({
    defaultValues: {
      reference: lastReference ?? "",
      consumerKind: "pat" as ConsumerKind,
      consumerId: "",
      recipientKeyId: "",
      recipientPublicKey: "",
      expiresAt: defaultExpiry(),
    },
    onSubmit: ({ value }) => {
      const found = sealedGrantIssues(value, Date.now());
      setIssues(found);
      if (found.length > 0) return;
      grant.mutate({
        kbId: kb.id,
        idempotencyKey: attempt.key,
        reference: value.reference.trim(),
        consumerKind: value.consumerKind,
        consumerId: value.consumerId.trim(),
        recipientKeyId: value.recipientKeyId.trim(),
        recipientPublicKey: value.recipientPublicKey.trim(),
        expiresAt: new Date(value.expiresAt).toISOString(),
      });
    },
  });
  return (
    <form
      className="min-w-0 space-y-3"
      aria-labelledby="sealed-grant-title"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <h3 id="sealed-grant-title" className="font-semibold">
        {t("settings.sealed.grantTitle")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("settings.sealed.grantDescription")}</p>
      <form.Field name="reference">
        {(field) => (
          <TextField
            field={field}
            label={t("settings.sealed.reference")}
            autoComplete="off"
            inputMode="text"
            inputClassName="font-mono"
            maxLength={160}
          />
        )}
      </form.Field>
      <form.Field name="consumerKind">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label htmlFor={kindId}>{t("settings.sealed.consumerKind")}</Label>
            <select
              id={kindId}
              className="min-h-[44px] w-full rounded-md border bg-background px-3 text-sm"
              value={field.state.value}
              onChange={(event) =>
                field.handleChange(CONSUMER_KINDS.find((k) => k === event.target.value) ?? "pat")
              }
            >
              {CONSUMER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`settings.sealed.kinds.${kind}`)}
                </option>
              ))}
            </select>
          </div>
        )}
      </form.Field>
      <form.Field name="consumerId">
        {(field) => (
          <TextField
            field={field}
            label={t("settings.sealed.consumerId")}
            autoComplete="off"
            inputMode="text"
            maxLength={128}
          />
        )}
      </form.Field>
      <form.Field name="recipientKeyId">
        {(field) => (
          <TextField
            field={field}
            label={t("settings.sealed.recipientKeyId")}
            autoComplete="off"
            inputMode="text"
            inputClassName="font-mono"
            maxLength={36}
          />
        )}
      </form.Field>
      <form.Field name="recipientPublicKey">
        {(field) => (
          <TextField
            field={field}
            label={t("settings.sealed.recipientPublicKey")}
            autoComplete="off"
            inputMode="text"
            inputClassName="font-mono"
            maxLength={44}
          />
        )}
      </form.Field>
      <form.Field name="expiresAt">
        {(field) => (
          <TextField
            field={field}
            type="datetime-local"
            label={t("settings.sealed.expiresAt")}
            autoComplete="off"
            inputMode="none"
          />
        )}
      </form.Field>
      {issues.map((issue) => (
        <p key={issue} role="alert" className="text-sm text-destructive">
          {t(`settings.sealed.issues.${issue}`)}
        </p>
      ))}
      <ControlError error={grant.error} testId="sealed-error" />
      {grant.isSuccess && (
        <p data-testid="sealed-grant-done" role="status" className="text-sm font-medium">
          {t("settings.sealed.grantDone")}
        </p>
      )}
      <Button
        type="submit"
        data-testid="sealed-grant"
        className="min-h-[44px]"
        disabled={grant.isPending}
      >
        {grant.isPending ? t("settings.sealed.granting") : t("settings.sealed.grant")}
      </Button>
    </form>
  );
}

function RevokeForm({ kb, onDenied }: { kb: KbLike } & Denied) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const session = useKbMutationSession();
  const [invalid, setInvalid] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const revoke = useMutation(
    orpc.kbSealed.revoke.mutationOptions({
      onSuccess: () => {
        if (!session.current) return;
        attempt.renew();
        setConfirming(null);
      },
      onError: (error) => {
        if (!session.current) return;
        setConfirming(null);
        deniedHandler(onDenied)(error);
      },
    }),
  );
  const form = useForm({
    defaultValues: { reference: "" },
    onSubmit: ({ value }) => {
      const reference = value.reference.trim();
      const valid = REFERENCE.test(reference);
      setInvalid(!valid);
      if (valid) setConfirming(reference);
    },
  });
  return (
    <form
      className="min-w-0 space-y-3"
      aria-labelledby="sealed-revoke-title"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <h3 id="sealed-revoke-title" className="font-semibold">
        {t("settings.sealed.revokeTitle")}
      </h3>
      <form.Field name="reference">
        {(field) => (
          <TextField
            field={field}
            label={t("settings.sealed.revokeReference")}
            autoComplete="off"
            inputMode="text"
            inputClassName="font-mono"
            maxLength={160}
          />
        )}
      </form.Field>
      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {t("settings.sealed.issues.reference")}
        </p>
      )}
      <ControlError error={revoke.error} testId="sealed-error" />
      {revoke.isSuccess && (
        <p data-testid="sealed-revoke-done" role="status" className="text-sm font-medium">
          {t("settings.sealed.revokeDone")}
        </p>
      )}
      <Button type="submit" data-testid="sealed-revoke" variant="outline" className="min-h-[44px]">
        {t("settings.sealed.revoke")}
      </Button>
      <ConfirmDeleteDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t("settings.sealed.revokeConfirmTitle")}
        description={t("settings.sealed.revokeConfirmDescription")}
        confirmToken="DELETE"
        typePrompt={t("settings.sealed.revokePrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.sealed.revokeAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={revoke.isPending}
        onConfirm={() =>
          confirming &&
          revoke.mutate({ kbId: kb.id, reference: confirming, idempotencyKey: attempt.key })
        }
      />
    </form>
  );
}

/**
 * Owner sealed controls: bounded secret input with opaque reference output,
 * exact single-record/single-key grants, and record revoke. There is no list
 * or read-back of records: the literal is never fetched.
 */
export function SealedPanel({ kb, onDenied }: { kb: KbLike; onDenied?: () => void }) {
  const { t } = useTranslation("kb");
  const [lastReference, setLastReference] = useState<string | null>(null);
  if (!sealedControls(kb.capabilities, kb.isOwner).visible) return null;
  return (
    <section
      data-testid="sealed-panel"
      aria-labelledby="kb-sealed-title"
      className="min-w-0 space-y-6"
    >
      <header className="space-y-1">
        <div className="flex items-center gap-1.5">
          <h2 id="kb-sealed-title" className="text-lg font-semibold">
            {t("settings.sealed.title")}
          </h2>
          <Help title={t("settings.sealed.title")}>
            <p>{t("settings.sealed.help")}</p>
          </Help>
        </div>
        <p className="text-sm text-muted-foreground">{t("settings.sealed.description")}</p>
      </header>
      <EnrollForm kb={kb} onEnrolled={setLastReference} onDenied={onDenied} />
      <GrantForm kb={kb} lastReference={lastReference} onDenied={onDenied} />
      <RevokeForm kb={kb} onDenied={onDenied} />
    </section>
  );
}
