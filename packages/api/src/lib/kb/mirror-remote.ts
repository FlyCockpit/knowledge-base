import type { ApprovedHostKey } from "./deploy-key";
import { KbDomainError } from "./errors";
import { type MirrorSshUrl, parseMirrorSshUrl } from "./ssh-url";

/**
 * Friendly remote input for the mirror setup. Every common spelling of a Git
 * remote is rewritten to the one canonical `ssh://git@host[:port]/path.git`
 * form and then handed to the strict parser, so the accepted set and every
 * existing validation rule stay exactly those of `parseMirrorSshUrl`.
 */

/** Closed set of refusal reasons the form explains by name. */
export const MIRROR_URL_REASONS = {
  notGit: "NOT_A_GIT_URL",
  sshUser: "SSH_USER_NOT_GIT",
  httpsPort: "HTTPS_PORT",
} as const;
type MirrorUrlReason = (typeof MIRROR_URL_REASONS)[keyof typeof MIRROR_URL_REASONS];

const refuse = (reason: MirrorUrlReason) =>
  new KbDomainError("INVALID_ARGUMENT", "Invalid mirror URL", undefined, { reason });

type Parts = { host: string; port: string | null; path: string; web: boolean };

const HOST_TEXT = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)$/;

function splitAuthority(authority: string): { host: string; port: string | null } {
  const bracketEnd = authority.lastIndexOf("]");
  const colon = authority.lastIndexOf(":");
  if (colon > bracketEnd)
    return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
  return { host: authority, port: null };
}

function parseForms(text: string): Parts {
  // ssh://, git+ssh:// and ssh+git:// spell the same SSH transport.
  const ssh = /^(?:ssh|git\+ssh|ssh\+git):\/\/([^/]*)(\/.*)?$/i.exec(text);
  if (ssh) {
    let authority = ssh[1]!;
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      if (authority.slice(0, at) !== "git") throw refuse(MIRROR_URL_REASONS.sshUser);
      authority = authority.slice(at + 1);
    }
    const { host, port } = splitAuthority(authority);
    return { host, port, path: ssh[2] ?? "", web: false };
  }
  // A browser or HTTPS clone URL names the same repository; only its host and
  // path are kept. Credentials embedded in it are dropped, never echoed.
  const web = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(text);
  if (web) {
    const authority = web[1]!.slice(web[1]!.lastIndexOf("@") + 1);
    const { host, port } = splitAuthority(authority);
    // An HTTPS port says nothing about the SSH port: ask for the SSH URL instead.
    if (port !== null && port !== "443" && port !== "80")
      throw refuse(MIRROR_URL_REASONS.httpsPort);
    return { host, port: null, path: web[2]!, web: true };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw refuse(MIRROR_URL_REASONS.notGit);
  // SCP-like `git@host:owner/repo.git` (or `host:owner/repo.git`).
  const scp =
    /^(?:([^@/:]+)@)?([A-Za-z0-9.-]+\.[A-Za-z0-9-]+|\[[0-9A-Fa-f:.]+\]):(?!\/\/)(.+)$/.exec(text);
  if (scp) {
    if (scp[1] !== undefined && scp[1] !== "git") throw refuse(MIRROR_URL_REASONS.sshUser);
    return { host: scp[2]!, port: null, path: `/${scp[3]!.replace(/^\/+/, "")}`, web: false };
  }
  // A bare `github.com/owner/repo`, as copied from an address bar without the scheme.
  const bare = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(\/[^?#]*)/.exec(text);
  if (bare) return { host: bare[1]!, port: null, path: bare[2]!, web: true };
  throw refuse(MIRROR_URL_REASONS.notGit);
}

function repositoryPath(host: string, rawPath: string, web: boolean): string {
  let segments = rawPath.split("/").filter((segment) => segment.length > 0);
  // Dot segments would be resolved differently before and after a page suffix
  // is cut (`/owner/old/../target`): refuse them instead of guessing.
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw refuse(MIRROR_URL_REASONS.notGit);
  if (web) {
    // Browser URLs of the known hosts carry page suffixes (`/tree/main`, `/-/issues`).
    const provider = providerForHost(host.toLowerCase());
    if (provider === "github" || provider === "bitbucket") segments = segments.slice(0, 2);
    if (provider === "gitlab") {
      const cut = segments.indexOf("-");
      if (cut >= 0) segments = segments.slice(0, cut);
    }
  }
  const last = segments.at(-1);
  if (last !== undefined && !last.endsWith(".git")) segments[segments.length - 1] = `${last}.git`;
  return `/${segments.join("/")}`;
}

/**
 * Normalise any common remote spelling and validate it with the strict parser.
 * Throws INVALID_ARGUMENT, with a named reason where the form can say more.
 */
export function normalizeMirrorRemote(raw: string): MirrorSshUrl {
  if (typeof raw !== "string") throw refuse(MIRROR_URL_REASONS.notGit);
  const text = raw.trim();
  // Backslashes and percent-escapes are read differently by browsers, URL
  // parsers and Git (`https://a\@b/` names host `a` in a browser): refuse them
  // before any splitting, so the shown URL is never a different reading.
  if (text.length === 0 || text.length > 1024 || !/^[\x21-\x7e]+$/.test(text) || /[\\%]/.test(text))
    throw refuse(MIRROR_URL_REASONS.notGit);
  const parts = parseForms(text);
  if (!HOST_TEXT.test(parts.host)) throw refuse(MIRROR_URL_REASONS.notGit);
  const path = repositoryPath(parts.host, parts.path, parts.web);
  const port = parts.port === null ? "" : `:${parts.port}`;
  // The strict parser owns every remaining rule (segments, port range, IDNA,
  // private-network hosts); its refusal reasons pass through unchanged.
  return parseMirrorSshUrl(`ssh://git@${parts.host.toLowerCase()}${port}${path}`);
}

export type MirrorProviderId = "github" | "gitlab" | "bitbucket";

type Provider = {
  host: string;
  /** Published SHA256 host-key fingerprints, by key type. */
  fingerprints: Readonly<Record<string, string>>;
  /** Where the provider publishes them. */
  fingerprintsSource: string;
  deployKeyUrl: (path: string) => string | null;
};

const withoutGit = (path: string) => path.replace(/\.git$/, "");

/**
 * Host keys pinned from each provider's own documentation (retrieved 2026-11-26).
 * A scanned key is trusted automatically only when its fingerprint equals one
 * of these; any other key for a pinned key type is a mismatch and is refused.
 */
export const MIRROR_PROVIDERS: Readonly<Record<MirrorProviderId, Provider>> = {
  github: {
    host: "github.com",
    // Source: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
    fingerprints: {
      "ssh-ed25519": "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
      "ecdsa-sha2-nistp256": "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
      "ssh-rsa": "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
    },
    fingerprintsSource:
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints",
    // GitHub repository paths are exactly owner/repo.
    deployKeyUrl: (path) =>
      path.split("/").length === 3
        ? `https://github.com${withoutGit(path)}/settings/keys/new`
        : null,
  },
  gitlab: {
    host: "gitlab.com",
    // Source: https://docs.gitlab.com/user/gitlab_com/#ssh-host-keys-fingerprints
    fingerprints: {
      "ssh-ed25519": "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8",
      "ecdsa-sha2-nistp256": "SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw",
      "ssh-rsa": "SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ",
    },
    fingerprintsSource: "https://docs.gitlab.com/user/gitlab_com/#ssh-host-keys-fingerprints",
    deployKeyUrl: (path) =>
      `https://gitlab.com${withoutGit(path)}/-/settings/repository#js-deploy-keys-settings`,
  },
  bitbucket: {
    host: "bitbucket.org",
    // Source: https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/
    fingerprints: {
      "ssh-ed25519": "SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM",
      "ecdsa-sha2-nistp256": "SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0",
      "ssh-rsa": "SHA256:46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E",
    },
    fingerprintsSource:
      "https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/",
    // Bitbucket repository access keys are read-only ("Grant read-only access",
    // https://support.atlassian.com/bitbucket-cloud/docs/set-up-repository-access-keys-on-linux/),
    // so the guide sends the key to a write-capable account instead of a page that cannot push.
    deployKeyUrl: () => null,
  },
};

function providerForHost(host: string): MirrorProviderId | null {
  for (const [id, provider] of Object.entries(MIRROR_PROVIDERS) as [MirrorProviderId, Provider][])
    if (provider.host === host) return id;
  return null;
}

/** A provider pin applies only to its public SSH endpoint on port 22. */
export function mirrorProvider(remote: Pick<MirrorSshUrl, "host" | "port">) {
  const id = remote.port === 22 ? providerForHost(remote.host) : null;
  return id ? { id, ...MIRROR_PROVIDERS[id] } : null;
}

export type HostKeyCheck = "PUBLISHED" | "MISMATCH" | "UNPINNED";

export function checkHostKey(
  remote: Pick<MirrorSshUrl, "host" | "port">,
  key: Pick<ApprovedHostKey, "algorithm" | "fingerprint">,
): HostKeyCheck {
  const provider = mirrorProvider(remote);
  const pinned = provider?.fingerprints[key.algorithm];
  if (!provider || pinned === undefined) return "UNPINNED";
  return pinned === key.fingerprint ? "PUBLISHED" : "MISMATCH";
}

export type HostKeyVerdict = "PUBLISHED" | "CONFIRM" | "MISMATCH" | "UNREACHABLE";

/**
 * Pinned host: auto-approve only if at least one key matches and none
 * contradicts the pins. Any other host: the user must confirm the fingerprints.
 */
export function hostKeyVerdict(
  remote: Pick<MirrorSshUrl, "host" | "port">,
  keys: readonly Pick<ApprovedHostKey, "algorithm" | "fingerprint">[],
): HostKeyVerdict {
  if (keys.length === 0) return "UNREACHABLE";
  if (!mirrorProvider(remote)) return "CONFIRM";
  const checks = keys.map((key) => checkHostKey(remote, key));
  if (checks.includes("MISMATCH") || !checks.includes("PUBLISHED")) return "MISMATCH";
  return "PUBLISHED";
}

export const MIRROR_HOST_KEY_REASONS = {
  mismatch: "HOST_KEY_MISMATCH",
  unconfirmed: "HOST_KEYS_UNCONFIRMED",
} as const;

/**
 * Configure-time trust gate. Keys for a pinned provider must each match the
 * published fingerprints, whatever the client claims. Keys for any other host
 * are stored only with the user's explicit confirmation: nothing is trusted
 * on first use.
 */
export function assertHostKeysTrusted(
  remote: Pick<MirrorSshUrl, "host" | "port">,
  keys: readonly ApprovedHostKey[],
  confirmation: "PUBLISHED" | "CONFIRMED",
): void {
  if (mirrorProvider(remote)) {
    if (keys.some((key) => checkHostKey(remote, key) !== "PUBLISHED"))
      throw new KbDomainError("INVALID_ARGUMENT", "Host key mismatch", undefined, {
        reason: MIRROR_HOST_KEY_REASONS.mismatch,
      });
    return;
  }
  if (confirmation !== "CONFIRMED")
    throw new KbDomainError("INVALID_ARGUMENT", "Host keys unconfirmed", undefined, {
      reason: MIRROR_HOST_KEY_REASONS.unconfirmed,
    });
}
