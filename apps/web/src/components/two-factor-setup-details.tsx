import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { toast } from "@knowledge-base/ui/components/sileo";
import { useTranslation } from "react-i18next";

import { LazyQRCode } from "@/components/lazy-qr-code";

function secretFromTotpURI(totpURI: string) {
  if (!URL.canParse(totpURI)) return "";
  return new URL(totpURI).searchParams.get("secret") || "";
}

export function TwoFactorSetupDetails({
  totpURI,
  backupCodes,
  qrPrompt,
  manualPrompt,
  backupCodesLabel,
}: {
  totpURI: string;
  backupCodes: string[];
  qrPrompt: string;
  manualPrompt: string;
  backupCodesLabel: string;
}) {
  const { t } = useTranslation(["auth", "errors"]);
  const secret = secretFromTotpURI(totpURI);

  return (
    <>
      {totpURI && URL.canParse(totpURI) ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{qrPrompt}</p>
          <div className="flex justify-center rounded bg-white p-4">
            <LazyQRCode value={totpURI} size={180} />
          </div>
        </div>
      ) : null}
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{manualPrompt}</p>
        {secret ? (
          <CopyField
            value={secret}
            copyLabel={t("auth:twoFactor.copySecretAriaLabel")}
            onCopied={() => toast.success(t("auth:twoFactor.secretCopied"))}
            onCopyError={() => toast.error(t("errors:couldNotCopy"))}
          />
        ) : null}
      </div>

      {backupCodes.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{backupCodesLabel}</p>
          <CodeSnippet
            code={backupCodes.join("\n")}
            copyLabel={t("auth:twoFactor.copyBackupCodesAriaLabel")}
            onCopied={() => toast.success(t("auth:twoFactor.backupCodesCopied"))}
            onCopyError={() => toast.error(t("errors:couldNotCopy"))}
          />
        </div>
      ) : null}
    </>
  );
}
