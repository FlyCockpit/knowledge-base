// ---------------------------------------------------------------------------
// Product name defaults. VITE_APP_NAME stays an optional
// per-deployment override; these are what a fresh install shows. Side-effect
// free and import-free, so the browser bundle, the Vite config (loaded by
// Node directly), the server and the mailer can all share them.
// ---------------------------------------------------------------------------

export const DEFAULT_APP_NAME = "KnowledgeBase";
/** Shown where the full name does not fit (phone header, PWA icon label). */
export const DEFAULT_APP_SHORT_NAME = "KB";

/** The short name: the default "KB" unless a deployment renamed the app. */
export function appShortName(appName: string): string {
  return appName === DEFAULT_APP_NAME ? DEFAULT_APP_SHORT_NAME : appName;
}
