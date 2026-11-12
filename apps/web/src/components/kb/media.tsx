import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Manifest entry at the document's pinned revision (CONTRACT `AssetRef`). */
export type AssetRef = { path: string; hash: string; size: number; mime: string };

const KB_ID = /^[a-z0-9]{24,32}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

/** Scheme, protocol-relative, fragment-only or empty: never a KB-relative path. */
function isExternal(destination: string): boolean {
  return (
    destination.length === 0 ||
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)
  );
}

/**
 * Repo-relative path for a Markdown destination, resolved exactly like the
 * server's `resolveMarkdownAssetReferences` (documents-read.ts): relative to
 * the document's directory (`/` = KB root), query/fragment dropped, percent-
 * decoded once, and never escaping the root. Input has already had CommonMark
 * escapes/entities decoded by the renderer; do not decode them a second time.
 * Null for anything external.
 */
export function resolveAssetDestination(raw: string, documentPath: string): string | null {
  const trimmed = raw.trim();
  if (isExternal(trimmed)) return null;
  const withoutFragment = trimmed.replace(/[?#].*$/, "");
  if (withoutFragment.length === 0) return null;
  let form = withoutFragment;
  try {
    form = decodeURIComponent(withoutFragment);
  } catch {
    // Malformed percent-encoding: the literal path, as on the server.
  }
  if (isExternal(form)) return null;
  const documentDir = documentPath.split("/").slice(0, -1);
  const segments = form.startsWith("/") ? form.split("/") : [...documentDir, ...form.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** The exact session-authenticated, revision-bound media route. */
export function kbAssetUrl(kbId: string, hash: string, rev: string): string {
  if (!KB_ID.test(kbId) || !HASH.test(hash) || !SHA.test(rev))
    throw new Error("Invalid asset reference");
  return `/kb-assets/${kbId}/${hash}?rev=${rev}`;
}

const IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO = new Set(["video/mp4", "video/webm"]);
const AUDIO = new Set(["audio/mpeg", "audio/wav", "audio/ogg"]);

/** True when the MIME is one this viewer may request at all. */
export const isRenderableMime = (mime: string) =>
  IMAGE.has(mime) || VIDEO.has(mime) || AUDIO.has(mime) || mime === "application/pdf";

const alertClass = "my-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm";

export function MissingAsset({ path }: { path: string }) {
  const { t } = useTranslation("kb");
  return (
    <span role="alert" className={`block ${alertClass}`}>
      {t("media.missing", { path })}
    </span>
  );
}

/** Editor preview only: a relative image the saved document does not reference yet. */
export function UnpreviewedAsset({ path }: { path: string }) {
  const { t } = useTranslation("kb");
  return (
    <span role="note" className="my-2 block rounded-md border p-3 text-sm text-muted-foreground">
      {t("media.notPreviewed", { path })}
    </span>
  );
}

export function ExternalMedia({ alt }: { alt: string }) {
  const { t } = useTranslation("kb");
  return (
    <span role="note" className="my-2 block rounded-md border p-3 text-sm text-muted-foreground">
      {alt ? t("media.external", { alt }) : t("media.externalNoAlt")}
    </span>
  );
}

/**
 * Trusted-MIME inline media. Images show alt text, video/audio get native
 * (keyboard-operable) controls and never autoplay, PDFs are download-only,
 * anything else (SVG, HTML, unknown) is announced and never requested.
 */
export function MediaEmbed({ asset, url, alt }: { asset: AssetRef; url: string; alt: string }) {
  return (
    <MediaResource
      key={JSON.stringify([url, asset.hash, asset.mime])}
      asset={asset}
      url={url}
      alt={alt}
    />
  );
}

/** Error callbacks belong to this resource's mount, including late events. */
function MediaResource({ asset, url, alt }: { asset: AssetRef; url: string; alt: string }) {
  const { t } = useTranslation("kb");
  const [failed, setFailed] = useState(false);
  const name = asset.path.split("/").at(-1) ?? asset.path;
  if (failed) {
    return (
      <span role="alert" className={`block ${alertClass}`}>
        {t("media.failed", { path: asset.path })}
      </span>
    );
  }
  if (IMAGE.has(asset.mime))
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="my-2 h-auto max-w-full rounded-md"
        onError={() => setFailed(true)}
      />
    );
  if (VIDEO.has(asset.mime))
    return (
      <video
        controls
        preload="metadata"
        src={url}
        aria-label={alt || name}
        className="my-2 max-w-full rounded-md"
        onError={() => setFailed(true)}
      />
    );
  if (AUDIO.has(asset.mime))
    return (
      <audio
        controls
        preload="metadata"
        src={url}
        aria-label={alt || name}
        className="my-2 w-full max-w-md"
        onError={() => setFailed(true)}
      />
    );
  if (asset.mime === "application/pdf")
    return (
      <a href={url} download={name} className="underline underline-offset-4">
        {t("media.downloadPdf", { name })}
      </a>
    );
  return (
    <span role="alert" className={`block ${alertClass}`}>
      {t("media.unsupported", { path: asset.path })}
    </span>
  );
}
