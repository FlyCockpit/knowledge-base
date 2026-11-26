import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { TextareaField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ControlError, describeControlError } from "@/components/kb/profile-panel";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { useTransientSecretMutation } from "@/hooks/use-transient-secret-mutation";
import { orpc } from "@/utils/orpc";
import {
  SEALED_LABEL_MAX,
  SEALED_PLAINTEXT_MAX_BYTES,
  sealedLabelIssue,
  sealedValueIssue,
  utf8ByteLength,
} from "./sealed-logic";

export type SealedKbLike = {
  id: string;
  capabilities: readonly string[];
  sealedNamespace: string;
  isOwner: boolean;
};
/** A value to give access to; `grants` are its known approvals (none for a value just added). */
export type SealedTarget = {
  reference: string;
  label: string | null;
  grants?: readonly { consumerId: string; recipientKeyId: string }[];
};

const LABEL_ISSUE = {
  required: "nameRequired",
  tooLong: "nameTooLong",
  invalid: "nameInvalid",
} as const;
const VALUE_ISSUE = { required: "valueRequired", tooLong: "valueTooLong" } as const;

/** The opaque reference: the only thing shown after a secret is saved. */
export function SealedReferenceReveal({ reference }: { reference: string }) {
  const { t } = useTranslation("kb");
  return (
    <div
      data-testid="sealed-reference"
      data-reference={reference}
      role="status"
      className="min-w-0 space-y-2 text-sm"
    >
      <p className="font-medium">{t("settings.sealed.addDialog.referenceLabel")}</p>
      <CopyField value={reference} copyLabel={t("settings.sealed.list.copyReference")} />
      <p className="text-xs text-muted-foreground">
        {t("settings.sealed.addDialog.referenceHint")}
      </p>
    </div>
  );
}

/**
 * Name + value → saved secret → copyable reference. The value lives only in
 * this form and the transient mutation; a saved value is never fetched back.
 */
function AddSecretBody({
  kb,
  onSaved,
  onGiveAccess,
  onInsertReference,
  onClose,
  onDenied,
}: {
  kb: SealedKbLike;
  onSaved: (target: SealedTarget) => void;
  onGiveAccess?: (target: SealedTarget) => void;
  onInsertReference?: (reference: string) => void;
  onClose: () => void;
  onDenied?: () => void;
}) {
  const { t } = useTranslation("kb");
  const attempt = useRenewableAttemptKey();
  const draft = useRef(0);
  const submittedDraft = useRef(0);
  // Per-field edit counters: a saved secret is cleared on success unless the
  // value field itself was edited while saving (a label-only edit never keeps it).
  const valueDraft = useRef(0);
  const submittedValueDraft = useRef(0);
  const submittedLabel = useRef<string | null>(null);
  const [saved, setSaved] = useState<SealedTarget | null>(null);
  const [issues, setIssues] = useState<{ label?: string; value?: string }>({});
  const enroll = useTransientSecretMutation(orpc.kbSealed.enroll.mutationOptions(), {
    onSuccess: (result) => {
      attempt.renew();
      const target = { reference: result.reference, label: submittedLabel.current };
      setSaved(target);
      onSaved(target);
      // An edit made while saving stays as the next draft, but the saved
      // value itself never survives into the next one.
      if (draft.current === submittedDraft.current) form.reset();
      else if (valueDraft.current === submittedValueDraft.current)
        form.setFieldValue("plaintext", "");
      enroll.reset();
    },
    onError: (error) => {
      if (describeControlError(error) === "denied") onDenied?.();
    },
  });
  const form = useForm({
    defaultValues: { label: "", plaintext: "" },
    onSubmit: ({ value }) => {
      const labelIssue = sealedLabelIssue(value.label);
      const valueIssue = sealedValueIssue(value.plaintext);
      setIssues({
        label: labelIssue ? t(`settings.sealed.addDialog.issues.${LABEL_ISSUE[labelIssue]}`) : "",
        value: valueIssue ? t(`settings.sealed.addDialog.issues.${VALUE_ISSUE[valueIssue]}`) : "",
      });
      if (labelIssue || valueIssue) return;
      setSaved(null);
      const idempotencyKey =
        draft.current === submittedDraft.current ? attempt.key : attempt.renew();
      const label = value.label.trim();
      const submitted = enroll.mutate({
        kbId: kb.id,
        namespace: kb.sealedNamespace,
        plaintext: value.plaintext,
        label,
        idempotencyKey,
      });
      if (submitted) {
        submittedDraft.current = draft.current;
        submittedValueDraft.current = valueDraft.current;
        submittedLabel.current = label;
      }
    },
  });

  if (saved)
    return (
      <div data-testid="sealed-saved" className="min-w-0 space-y-4">
        <p role="status" className="text-sm font-medium">
          {t("settings.sealed.addDialog.saved")}
        </p>
        <SealedReferenceReveal reference={saved.reference} />
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            data-testid="sealed-add-another"
            onClick={() => setSaved(null)}
          >
            {t("settings.sealed.addDialog.addAnother")}
          </Button>
          {onInsertReference && (
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              data-testid="sealed-insert"
              onClick={() => {
                onInsertReference(saved.reference);
                onClose();
              }}
            >
              {t("settings.sealed.addDialog.insert")}
            </Button>
          )}
          {onGiveAccess && (
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              data-testid="sealed-saved-give-access"
              onClick={() => onGiveAccess(saved)}
            >
              {t("settings.sealed.addDialog.giveAccess")}
            </Button>
          )}
          <Button type="button" className="min-h-[44px]" onClick={onClose}>
            {t("settings.sealed.addDialog.done")}
          </Button>
        </DialogFooter>
      </div>
    );

  return (
    <form
      className="min-w-0 space-y-4"
      noValidate
      onChange={(event) => {
        draft.current += 1;
        if ((event.target as { name?: string }).name === "plaintext") valueDraft.current += 1;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="label">
        {(field) => (
          <div className="space-y-1">
            <TextField
              field={field}
              label={t("settings.sealed.addDialog.name")}
              placeholder={t("settings.sealed.addDialog.namePlaceholder")}
              autoComplete="off"
              inputMode="text"
              maxLength={SEALED_LABEL_MAX}
            />
            {issues.label && (
              <p role="alert" className="text-sm text-destructive">
                {issues.label}
              </p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="plaintext">
        {(field) => {
          const bytes = utf8ByteLength(field.state.value);
          return (
            <div className="space-y-1">
              <TextareaField
                field={field}
                label={t("settings.sealed.addDialog.value")}
                autoComplete="off"
                spellCheck={false}
                rows={3}
                description={
                  bytes > SEALED_PLAINTEXT_MAX_BYTES
                    ? t("settings.sealed.addDialog.issues.valueTooLong")
                    : t("settings.sealed.addDialog.bytes", {
                        count: bytes,
                        max: SEALED_PLAINTEXT_MAX_BYTES,
                      })
                }
              />
              {issues.value && (
                <p role="alert" className="text-sm text-destructive">
                  {issues.value}
                </p>
              )}
            </div>
          );
        }}
      </form.Field>
      <ControlError error={enroll.error} testId="sealed-error" />
      <DialogFooter className="flex-col gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="min-h-[44px]" onClick={onClose}>
          {t("settings.sealed.grantDialog.cancel")}
        </Button>
        <Button
          type="submit"
          data-testid="sealed-enroll"
          className="min-h-[44px]"
          disabled={enroll.isPending}
        >
          {enroll.isPending
            ? t("settings.sealed.addDialog.saving")
            : t("settings.sealed.addDialog.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Add a secret: name + value → the reference to paste into a document.
 * Also exported for the kb-workspace editor: pass `onInsertReference` to show
 * an "Insert into document" button that hands the new reference to the editor.
 */
export function SealedAddSecretDialog({
  kb,
  open,
  onOpenChange,
  onSaved,
  onGiveAccess,
  onInsertReference,
  onDenied,
}: {
  kb: SealedKbLike;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (target: SealedTarget) => void;
  /** Omitted: the success view offers no "Give access" shortcut. */
  onGiveAccess?: (target: SealedTarget) => void;
  onInsertReference?: (reference: string) => void;
  onDenied?: () => void;
}) {
  const { t } = useTranslation("kb");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="sealed-add-dialog"
        className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{t("settings.sealed.addDialog.title")}</DialogTitle>
          <DialogDescription>{t("settings.sealed.addDialog.description")}</DialogDescription>
        </DialogHeader>
        <AddSecretBody
          kb={kb}
          onSaved={(target) => onSaved?.(target)}
          onGiveAccess={
            onGiveAccess
              ? (target) => {
                  onOpenChange(false);
                  onGiveAccess(target);
                }
              : undefined
          }
          onInsertReference={onInsertReference}
          onClose={() => onOpenChange(false)}
          onDenied={onDenied}
        />
      </DialogContent>
    </Dialog>
  );
}
