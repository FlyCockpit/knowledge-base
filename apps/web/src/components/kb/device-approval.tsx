import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { Checkbox } from "@knowledge-base/ui/components/checkbox";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Label } from "@knowledge-base/ui/components/label";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthScreen } from "@/components/auth/auth-screen";
import { InlineRetry } from "@/components/inline-retry";
import { AclPicker } from "@/components/kb/acl-picker";
import {
  type DeviceClaim,
  type DevicePhase,
  type DeviceRecipient,
  formatUserCode,
} from "@/hooks/use-device-approval";
import type {
  CredentialSelection,
  LiveKbOption,
  SelectionAction,
  SelectionIssue,
} from "@/hooks/use-mcp-consent";
import { useMountEffect } from "@/hooks/use-mount-effect";

export type DeviceApprovalProps = {
  phase: DevicePhase;
  /** `null` only alongside a terminal phase (e.g. the claim itself was refused). */
  claim: DeviceClaim | null;
  live: readonly LiveKbOption[];
  kbs: {
    isError: boolean;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    onRetry: () => void;
    onLoadMore: () => void;
  };
  selection: CredentialSelection;
  recipients?: readonly DeviceRecipient[];
  onAddRecipient?: (recipient: DeviceRecipient) => void;
  onRemoveRecipient?: (recordId: string) => void;
  onChange: (action: SelectionAction) => void;
  issues: readonly SelectionIssue[];
  onApprove: () => void;
  onDeny: () => void;
  onRetry: () => void;
  onReviewAgain: () => void;
  onSignIn: () => void;
};

const TERMINAL = ["approved", "denied", "unavailable", "refused", "uncertain", "signIn"] as const;
type Terminal = (typeof TERMINAL)[number];
const isTerminal = (phase: DevicePhase): phase is { kind: Terminal } =>
  (TERMINAL as readonly string[]).includes(phase.kind);

/**
 * CLI device approval: the code to compare, the requesting client, and the
 * same explicit ACL/create picker as OAuth consent (nothing preselected, no
 * implicit all-KBs). Every server outcome has its own visible state.
 */
export function DeviceApproval(props: DeviceApprovalProps) {
  const { t } = useTranslation(["consent", "settings", "common"]);
  const { phase, claim, kbs } = props;
  const [sealedDraft, setSealedDraft] = useState(false);
  if (isTerminal(phase)) {
    return (
      <DeviceStatus
        title={t(`consent:device.${phase.kind}Title`)}
        body={t(`consent:device.${phase.kind}Body`)}
      >
        {(phase.kind === "unavailable" || phase.kind === "uncertain") && <TokenSettingsLink />}
        {phase.kind === "signIn" && (
          <Button className="min-h-[44px]" onClick={props.onSignIn}>
            {t("consent:device.signIn")}
          </Button>
        )}
      </DeviceStatus>
    );
  }
  if (!claim) return null;
  const busy = phase.kind === "submitting";
  const draftBlocks = Boolean(claim.recipientKey) && sealedDraft;
  return (
    <AuthScreen>
      <Card className="my-8 w-full max-w-xl">
        <CardHeader>
          <CardTitle className="text-2xl">{t("consent:device.title")}</CardTitle>
          <CardDescription>{t("consent:device.description")}</CardDescription>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-2 text-sm">
            <dt className="text-muted-foreground">{t("consent:device.codeLabel")}</dt>
            <dd className="min-w-0 font-mono text-lg font-semibold tracking-widest">
              {formatUserCode(claim.userCode)}
            </dd>
            <dt className="text-muted-foreground">{t("consent:device.clientId")}</dt>
            <dd className="min-w-0 break-all font-mono">{claim.clientId}</dd>
          </dl>
          <p className="pt-2 text-xs text-muted-foreground">{t("consent:device.compare")}</p>
          <p className="text-xs text-muted-foreground">{t("consent:device.notAToken")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {phase.kind === "rightsChanged" && (
            <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm">
              <p>{t("consent:device.rightsChanged")}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 min-h-[44px]"
                onClick={props.onReviewAgain}
              >
                {t("consent:device.reviewAgain")}
              </Button>
            </div>
          )}
          {kbs.isError ? (
            <InlineRetry message={t("settings:credentials.kbsLoadError")} onRetry={kbs.onRetry} />
          ) : (
            <AclPicker
              live={props.live}
              selection={props.selection}
              onChange={props.onChange}
              scopeMode="fixed"
              fixedScopes={claim.scopes}
              writeScopeSelected={claim.scopes.includes("mcp:write")}
              offerSealed
              disabled={busy || phase.kind === "error"}
            />
          )}
          {kbs.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={kbs.isFetchingNextPage}
              onClick={kbs.onLoadMore}
            >
              {t("common:actions.loadMore")}
            </Button>
          )}
          {claim.recipientKey && (
            <DeviceRecipients
              recipientKey={claim.recipientKey}
              live={props.live}
              selection={props.selection}
              recipients={props.recipients ?? []}
              onAdd={props.onAddRecipient ?? (() => undefined)}
              onRemove={props.onRemoveRecipient ?? (() => undefined)}
              onDraftChange={setSealedDraft}
              disabled={busy || phase.kind === "error"}
            />
          )}
          {props.issues.map((issue) => (
            <p key={issue} className="text-sm text-muted-foreground">
              {t(`settings:credentials.picker.issues.${issue}`)}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">{t("consent:device.expiry")}</p>
          {phase.kind === "error" && (
            <InlineRetry
              variant="destructive"
              message={t(
                phase.decisionUncertain
                  ? "consent:device.uncertainBody"
                  : "consent:device.errorBody",
              )}
              onRetry={props.onRetry}
            />
          )}
          {phase.kind === "error" && phase.decisionUncertain && <TokenSettingsLink />}
          {draftBlocks && (
            <p role="status" data-testid="device-sealed-draft" className="text-sm text-destructive">
              {t("consent:device.recipients.draftPending")}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={props.onDeny}>
            {busy && phase.decision === "deny"
              ? t("consent:device.denying")
              : t("consent:device.deny")}
          </Button>
          <Button
            className="min-h-[44px]"
            disabled={
              busy ||
              phase.kind === "error" ||
              phase.kind === "rightsChanged" ||
              kbs.isError ||
              props.issues.length > 0 ||
              draftBlocks
            }
            onClick={props.onApprove}
          >
            {busy && phase.decision === "approve"
              ? t("consent:device.approving")
              : t("consent:device.approve")}
          </Button>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}

function TokenSettingsLink() {
  const { t, i18n } = useTranslation("consent");
  return (
    <Link
      className="inline-flex min-h-[44px] items-center underline"
      to="/$lang/settings/mcp"
      params={{ lang: i18n.language }}
    >
      {t("device.manageTokens")}
    </Link>
  );
}

/** Exact symbolic references only: no record enumeration or wildcard. The
 * CLI key comes solely from the claimed server intent, never an editable URL. */
function DeviceRecipients({
  recipientKey,
  live,
  selection,
  recipients,
  onAdd,
  onRemove,
  onDraftChange,
  disabled,
}: {
  recipientKey: NonNullable<DeviceClaim["recipientKey"]>;
  /** True while the form holds input that was not added as a record. */
  onDraftChange: (pending: boolean) => void;
  live: readonly LiveKbOption[];
  selection: CredentialSelection;
  recipients: readonly DeviceRecipient[];
  onAdd: (recipient: DeviceRecipient) => void;
  onRemove: (recordId: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("consent");
  const id = useId();
  const parseReference = (reference: string) => {
    const match = /^\{\{sealed:v1:knowledge_base:([0-9a-f-]{36}):([0-9a-f-]{36})\}\}$/.exec(
      reference.trim(),
    );
    const kb =
      match &&
      live.find(
        (item) => item.namespace === match[1] && selection.acl[item.kbId]?.includes("read"),
      );
    return { match, kb };
  };
  const parseExpiry = (value: string) => {
    const expiry = Date.parse(value);
    return Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 90 * 86400000
      ? expiry
      : null;
  };
  const form = useForm({
    defaultValues: { reference: "", expiresAt: "", checked: false },
    // Unadded input blocks Approve, so a record that failed to add is never
    // silently left out of the issued token (R2-27).
    listeners: {
      onChange: ({ formApi }) => {
        const { reference, expiresAt, checked } = formApi.state.values;
        onDraftChange(reference.trim() !== "" || expiresAt !== "" || checked);
      },
    },
    onSubmit: ({ value }) => {
      const { match, kb } = parseReference(value.reference);
      const expiry = parseExpiry(value.expiresAt);
      // The field validators below already said why; this only narrows types.
      if (!value.checked || !match || !kb || expiry === null || disabled) return;
      onAdd({
        kbId: kb.kbId,
        namespace: match[1]!,
        recordId: match[2]!,
        ...recipientKey,
        expiresAt: new Date(expiry).toISOString(),
      });
      form.reset();
      onDraftChange(false);
    },
  });
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t("device.recipients.title")}</legend>
      <p className="text-sm text-muted-foreground">{t("device.recipients.hint")}</p>
      <CopyField value={recipientKey.recipientKeyId} copyLabel={t("device.recipients.copyKeyId")} />
      <CopyField
        value={recipientKey.recipientPublicKey}
        copyLabel={t("device.recipients.copyPublicKey")}
      />
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <form.Field
          name="reference"
          validators={{
            onSubmit: ({ value }) => {
              const { match, kb } = parseReference(value);
              if (!match)
                return t("device.recipients.errors.reference", {
                  example: "{{sealed:v1:knowledge_base:…:…}}",
                });
              if (!kb) return t("device.recipients.errors.readRequired");
              return undefined;
            },
          }}
        >
          {(field) => (
            <TextField
              field={field}
              label={t("device.recipients.reference")}
              autoComplete="off"
              inputMode="text"
              maxLength={160}
              disabled={disabled}
            />
          )}
        </form.Field>
        <form.Field
          name="expiresAt"
          validators={{
            onSubmit: ({ value }) =>
              parseExpiry(value) === null ? t("device.recipients.errors.expiresAt") : undefined,
          }}
        >
          {(field) => (
            <TextField
              field={field}
              label={t("device.recipients.expiresAt")}
              type="datetime-local"
              autoComplete="off"
              inputMode="text"
              disabled={disabled}
            />
          )}
        </form.Field>
        <form.Field name="checked">
          {(field) => (
            <div className="flex min-h-[44px] items-center gap-3">
              <Checkbox
                id={id}
                aria-labelledby={`${id}-label`}
                checked={field.state.value}
                disabled={disabled}
                onCheckedChange={(checked) => field.handleChange(checked === true)}
              />
              <Label id={`${id}-label`} htmlFor={id}>
                {t("device.recipients.confirm")}
              </Label>
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.checked}>
          {(checked) => (
            <Button
              type="submit"
              variant="outline"
              className="min-h-[44px]"
              disabled={disabled || !checked || recipients.length >= 256}
            >
              {t("device.recipients.add")}
            </Button>
          )}
        </form.Subscribe>
      </form>
      {recipients.map((recipient) => (
        <div key={recipient.recordId} className="space-y-2">
          <CopyField
            value={`{{sealed:v1:knowledge_base:${recipient.namespace}:${recipient.recordId}}}`}
            copyLabel={t("device.recipients.copyReference")}
          />
          <p className="text-sm">
            {t("device.recipients.selectedExpiry", { expiresAt: recipient.expiresAt })}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            disabled={disabled}
            onClick={() => onRemove(recipient.recordId)}
          >
            {t("device.recipients.remove")}
          </Button>
        </div>
      ))}
    </fieldset>
  );
}

function DeviceStatus({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to the outcome so keyboard and screen-reader users hear it.
  useMountEffect(() => heading.current?.focus());
  return (
    <AuthScreen>
      <Card className="w-full max-w-md" role="status">
        <CardHeader>
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
            {title}
          </h1>
          {body && <CardDescription>{body}</CardDescription>}
        </CardHeader>
        {children && <CardFooter>{children}</CardFooter>}
      </Card>
    </AuthScreen>
  );
}

/** Manual entry when the CLI's link carried no (valid) code. Submits the normalized-by-caller raw value. */
export function DeviceCodeForm({
  onSubmit,
  invalid = false,
}: {
  onSubmit: (raw: string) => void;
  invalid?: boolean;
}) {
  const { t } = useTranslation("consent");
  const form = useForm({
    defaultValues: { code: "" },
    onSubmit: ({ value }) => onSubmit(value.code),
  });
  return (
    <AuthScreen>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">{t("device.enterTitle")}</CardTitle>
          <CardDescription>{t("device.enterDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <form.Field name="code">
              {(field) => (
                <TextField
                  field={field}
                  label={t("device.codeLabel")}
                  autoComplete="off"
                  inputMode="text"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={16}
                />
              )}
            </form.Field>
            {invalid && (
              <p role="alert" className="text-sm text-destructive">
                {t("device.codeInvalid")}
              </p>
            )}
            <Button type="submit" className="min-h-[44px] w-full">
              {t("device.continue")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthScreen>
  );
}
