import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseApprovedHostKeys } from "./deploy-key";
import {
  assertHostKeysTrusted,
  checkHostKey,
  hostKeyVerdict,
  MIRROR_PROVIDERS,
  mirrorProvider,
  normalizeMirrorRemote,
} from "./mirror-remote";

const normal = (raw: string) => normalizeMirrorRemote(raw).url;
const reasonOf = (raw: string) => {
  try {
    normalizeMirrorRemote(raw);
  } catch (error) {
    return (
      ((error as { details?: { reason?: string } }).details?.reason ??
        (error as { code?: string }).code) ||
      "thrown"
    );
  }
  return "accepted";
};

describe("mirror remote normalisation", () => {
  it.each([
    // Browser and HTTPS clone URLs.
    ["https://github.com/owner/repo", "ssh://git@github.com/owner/repo.git"],
    ["https://github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"],
    ["https://github.com/owner/repo/", "ssh://git@github.com/owner/repo.git"],
    ["https://github.com/owner/repo/tree/main/docs", "ssh://git@github.com/owner/repo.git"],
    ["https://github.com/owner/repo?tab=readme#top", "ssh://git@github.com/owner/repo.git"],
    ["https://GitHub.com/Owner/Repo", "ssh://git@github.com/Owner/Repo.git"],
    ["https://user:token@github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"],
    ["https://github.com:443/owner/repo", "ssh://git@github.com/owner/repo.git"],
    ["http://git.example.com/team/repo", "ssh://git@git.example.com/team/repo.git"],
    ["https://gitlab.com/group/sub/project", "ssh://git@gitlab.com/group/sub/project.git"],
    ["https://gitlab.com/group/project/-/tree/main", "ssh://git@gitlab.com/group/project.git"],
    ["https://bitbucket.org/ws/repo/src/main/", "ssh://git@bitbucket.org/ws/repo.git"],
    ["github.com/owner/repo", "ssh://git@github.com/owner/repo.git"],
    // SCP-like SSH.
    ["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"],
    ["git@github.com:owner/repo", "ssh://git@github.com/owner/repo.git"],
    ["github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"],
    ["git@git.example.com:/team/repo.git", "ssh://git@git.example.com/team/repo.git"],
    // ssh:// spellings.
    ["ssh://git@git.example.com:2222/a/b/c.git", "ssh://git@git.example.com:2222/a/b/c.git"],
    ["ssh://git@git.example.com:22/team/repo", "ssh://git@git.example.com/team/repo.git"],
    ["ssh://git.example.com/team/repo.git", "ssh://git@git.example.com/team/repo.git"],
    ["git+ssh://git@git.example.com/team/repo.git", "ssh://git@git.example.com/team/repo.git"],
    ["SSH://git@git.example.com/team/repo.git", "ssh://git@git.example.com/team/repo.git"],
    ["  git@github.com:owner/repo.git  ", "ssh://git@github.com/owner/repo.git"],
  ])("%s → %s", (raw, expected) => {
    expect(normal(raw)).toBe(expected);
  });

  it.each([
    ["", "NOT_A_GIT_URL"],
    ["not a url", "NOT_A_GIT_URL"],
    ["ftp://git.example.com/team/repo.git", "NOT_A_GIT_URL"],
    ["file:///srv/repo.git", "NOT_A_GIT_URL"],
    ["owner/repo", "NOT_A_GIT_URL"],
    ["root@git.example.com:team/repo.git", "SSH_USER_NOT_GIT"],
    ["ssh://deploy@git.example.com/team/repo.git", "SSH_USER_NOT_GIT"],
    ["ssh://git:pw@git.example.com/team/repo.git", "SSH_USER_NOT_GIT"],
    ["https://git.example.com:3000/team/repo", "HTTPS_PORT"],
    // Existing strict rules still apply after normalisation.
    ["https://10.0.0.5/team/repo", "PRIVATE_NETWORK_HOST"],
    ["git@localhost.localhost:team/repo.git", "PRIVATE_NETWORK_HOST"],
    ["https://127.0.0.1/team/repo", "PRIVATE_NETWORK_HOST"],
    ["https://github.com/owner", "INVALID_ARGUMENT"],
    ["https://git.example.com/team/../repo", "NOT_A_GIT_URL"],
    ["https://git.example.com/team/-repo", "INVALID_ARGUMENT"],
    ["git@git.example.com:team/repo;rm.git", "INVALID_ARGUMENT"],
    ["ssh://git@-oProxyCommand=sh/o/r.git", "NOT_A_GIT_URL"],
    ["-oProxyCommand=touch", "NOT_A_GIT_URL"],
    ["ssh://git@git.example.com/team/repo.git\nmore", "NOT_A_GIT_URL"],
    ["https://bücher.example/team/repo", "NOT_A_GIT_URL"],
    // Readings that differ between browsers, URL parsers and Git are refused, not guessed.
    ["https://github.com\\@evil.example/owner/repo", "NOT_A_GIT_URL"],
    ["https://github.com\\owner\\repo", "NOT_A_GIT_URL"],
    ["git@github.com:owner\\repo.git", "NOT_A_GIT_URL"],
    ["https://github.com/owner/old/../target", "NOT_A_GIT_URL"],
    ["https://github.com/owner/./repo", "NOT_A_GIT_URL"],
    ["git@git.example.com:team/../repo.git", "NOT_A_GIT_URL"],
    ["https://github.com%2fevil.example/owner/repo", "NOT_A_GIT_URL"],
    ["https://git.example.com/team/re%70o", "NOT_A_GIT_URL"],
  ])("refuses %j (%s)", (raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it("follows URL semantics for userinfo and shows the host it will actually use", () => {
    // Everything before the last @ of an HTTPS authority is userinfo, as in
    // every browser; the canonical URL shown to the user names the real host.
    expect(normal("https://github.com@evil.example/owner/repo")).toBe(
      "ssh://git@evil.example/owner/repo.git",
    );
  });

  it("is idempotent on its own output", () => {
    for (const raw of [
      "https://gitlab.com/a/b/c",
      "git@github.com:o/r",
      "ssh://git@h.example:2200/x/y",
    ])
      expect(normal(normal(raw))).toBe(normal(raw));
  });
});

describe("provider fingerprint pins", () => {
  // Full Ed25519 host keys as each provider publishes them (known_hosts pages):
  // their SHA256 fingerprints must equal the pinned values.
  const PUBLISHED_ED25519 = {
    github: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    gitlab: "AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
    bitbucket: "AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
  } as const;

  it("pins exactly the providers' published SHA256 fingerprints", () => {
    expect(
      Object.fromEntries(
        Object.entries(MIRROR_PROVIDERS).map(([id, p]) => [
          id,
          { host: p.host, ...p.fingerprints },
        ]),
      ),
    ).toEqual({
      github: {
        host: "github.com",
        "ssh-ed25519": "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
        "ecdsa-sha2-nistp256": "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
        "ssh-rsa": "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
      },
      gitlab: {
        host: "gitlab.com",
        "ssh-ed25519": "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8",
        "ecdsa-sha2-nistp256": "SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw",
        "ssh-rsa": "SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ",
      },
      bitbucket: {
        host: "bitbucket.org",
        "ssh-ed25519": "SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM",
        "ecdsa-sha2-nistp256": "SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0",
        "ssh-rsa": "SHA256:46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E",
      },
    });
  });

  it.each(Object.entries(PUBLISHED_ED25519))(
    "%s's published Ed25519 key hashes to its pin",
    (id, b64) => {
      const [key] = parseApprovedHostKeys([`ssh-ed25519 ${b64}`]);
      const host = MIRROR_PROVIDERS[id as keyof typeof MIRROR_PROVIDERS].host;
      expect(key!.fingerprint).toBe(
        `SHA256:${createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64").replace(/=+$/, "")}`,
      );
      expect(checkHostKey({ host, port: 22 }, key!)).toBe("PUBLISHED");
    },
  );

  it("each pin cites its source and links deploy keys only where they can write", () => {
    for (const provider of Object.values(MIRROR_PROVIDERS))
      expect(provider.fingerprintsSource).toMatch(
        /^https:\/\/(docs\.github\.com|docs\.gitlab\.com|support\.atlassian\.com)\//,
      );
    expect(MIRROR_PROVIDERS.github.deployKeyUrl("/owner/repo.git")).toBe(
      "https://github.com/owner/repo/settings/keys/new",
    );
    expect(MIRROR_PROVIDERS.gitlab.deployKeyUrl("/group/sub/project.git")).toBe(
      "https://gitlab.com/group/sub/project/-/settings/repository#js-deploy-keys-settings",
    );
    // Bitbucket repository access keys are read-only: no link into a dead end.
    expect(MIRROR_PROVIDERS.bitbucket.deployKeyUrl("/ws/repo.git")).toBeNull();
  });

  it("applies a pin only to the provider's own host on port 22", () => {
    expect(mirrorProvider({ host: "github.com", port: 22 })?.id).toBe("github");
    expect(mirrorProvider({ host: "github.com", port: 443 })).toBeNull();
    expect(mirrorProvider({ host: "ssh.github.com", port: 22 })).toBeNull();
    expect(mirrorProvider({ host: "github.com.evil.example", port: 22 })).toBeNull();
  });
});

const randomEd25519 = () => {
  const len = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const blob = Buffer.concat([len(11), Buffer.from("ssh-ed25519"), len(32), randomBytes(32)]);
  return parseApprovedHostKeys([`ssh-ed25519 ${blob.toString("base64")}`])[0]!;
};
const githubEd25519 = parseApprovedHostKeys([
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
])[0]!;
const github = { host: "github.com", port: 22 };
const other = { host: "git.example.com", port: 22 };

describe("host-key verdicts", () => {
  it("auto-approves a known provider only on a published match", () => {
    expect(hostKeyVerdict(github, [githubEd25519])).toBe("PUBLISHED");
    expect(hostKeyVerdict(github, [randomEd25519()])).toBe("MISMATCH");
    // A matching key does not excuse a contradicting one of a pinned type.
    expect(
      hostKeyVerdict(github, [githubEd25519, { ...randomEd25519(), algorithm: "ssh-rsa" }]),
    ).toBe("MISMATCH");
    // An unpinned type alone never auto-approves a pinned host.
    expect(hostKeyVerdict(github, [{ ...randomEd25519(), algorithm: "ecdsa-sha2-nistp384" }])).toBe(
      "MISMATCH",
    );
  });
  it("asks for confirmation for any other host, and reports nothing scanned as unreachable", () => {
    expect(hostKeyVerdict(other, [randomEd25519()])).toBe("CONFIRM");
    expect(hostKeyVerdict(other, [])).toBe("UNREACHABLE");
    expect(hostKeyVerdict(github, [])).toBe("UNREACHABLE");
  });
});

describe("configure-time trust gate (no trust on first use)", () => {
  const reason = (run: () => void) => {
    try {
      run();
      return "accepted";
    } catch (error) {
      return (error as { details?: { reason?: string } }).details?.reason;
    }
  };
  it("accepts a pinned provider's keys only when every key matches its pins", () => {
    expect(reason(() => assertHostKeysTrusted(github, [githubEd25519], "PUBLISHED"))).toBe(
      "accepted",
    );
    expect(reason(() => assertHostKeysTrusted(github, [githubEd25519], "CONFIRMED"))).toBe(
      "accepted",
    );
    expect(reason(() => assertHostKeysTrusted(github, [randomEd25519()], "CONFIRMED"))).toBe(
      "HOST_KEY_MISMATCH",
    );
    expect(
      reason(() => assertHostKeysTrusted(github, [githubEd25519, randomEd25519()], "PUBLISHED")),
    ).toBe("HOST_KEY_MISMATCH");
  });
  it("requires the user's explicit confirmation for any other host", () => {
    expect(reason(() => assertHostKeysTrusted(other, [randomEd25519()], "CONFIRMED"))).toBe(
      "accepted",
    );
    expect(reason(() => assertHostKeysTrusted(other, [randomEd25519()], "PUBLISHED"))).toBe(
      "HOST_KEYS_UNCONFIRMED",
    );
  });
});
