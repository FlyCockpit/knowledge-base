/**
 * `/install.sh` and `/install.ps1` rendering and routes, and `/install.sh` behavior. The rendered
 * script runs under `sh` (and `dash` where it is installed) against stub `curl`, `uname`, `sysctl`
 * and `cargo` commands, a local fixture release and a stub `kb`, so nothing touches the network or a
 * real toolchain.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";

const RELEASE = "https://releases.example.com/kb/v1.0.0";
const REV = "0123456789abcdef0123456789abcdef01234567";
const mockEnv = vi.hoisted(() => ({
  BETTER_AUTH_URL: "https://kb.example.com/",
  KB_CLI_RELEASE_BASE_URL: undefined as string | undefined,
  KB_CLI_SOURCE_REV: undefined as string | undefined,
}));
vi.mock("@knowledge-base/env/server", () => ({ env: mockEnv }));

const {
  CLI_RELEASE_TARGETS,
  CLI_REPOSITORY,
  CLI_WINDOWS_TARGET,
  cliInstallSource,
  defaultCliReleaseBaseUrl,
  installScript,
  registerCliInstallRoutes,
  windowsInstallScript,
} = await import("./cli-install.js");
const { SERVER_VERSION } = await import("./version.js");

const ORIGIN = "https://kb.example.com";
const repoRoot = join(import.meta.dirname, "../../..");

function has(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

describe("installer source and version", () => {
  it("chooses a pinned commit, then the configured release, then this version's GitHub Release", () => {
    expect(cliInstallSource(undefined, undefined)).toEqual({
      kind: "release",
      baseUrl: `${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}`,
    });
    expect(cliInstallSource(undefined, RELEASE)).toEqual({ kind: "release", baseUrl: RELEASE });
    // A pinned commit always builds from source, whatever the release URL says.
    expect(cliInstallSource(REV, RELEASE)).toEqual({ kind: "source", rev: REV });
  });

  it("pins the version the server, the CLI and the release share", () => {
    const cargo = readFileSync(join(repoRoot, "apps/cli/Cargo.toml"), "utf8");
    expect(/^\[package\][^[]*?^version = "([^"]+)"$/m.exec(cargo)?.[1]).toBe(SERVER_VERSION);
    const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/server/package.json"), "utf8"));
    expect(pkg.version).toBe(SERVER_VERSION);
    // The Release workflow refuses a tag that differs from SERVER_VERSION.
    const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    expect(release).toContain("apps/server/src/version.ts");
    expect(defaultCliReleaseBaseUrl()).toBe(
      `https://github.com/FlyCockpit/knowledge-base/releases/download/v${SERVER_VERSION}`,
    );
  });

  it("downloads only targets cargo-dist builds, as .tar.xz", () => {
    const dist = readFileSync(join(repoRoot, "apps/cli/dist-workspace.toml"), "utf8");
    const targets = /^targets = \[(.*)\]$/m.exec(dist)?.[1] ?? "";
    for (const target of [...CLI_RELEASE_TARGETS, CLI_WINDOWS_TARGET]) {
      expect(targets).toContain(`"${target}"`);
    }
    expect(dist).not.toMatch(/unix-archive|windows-archive/);
    expect(dist).toMatch(/^install-path = "CARGO_HOME"$/m);
  });

  it("refuses to publish a release the installers cannot verify, and attests it", () => {
    const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    for (const target of CLI_RELEASE_TARGETS) expect(release).toContain(`kb-${target}.tar.xz`);
    expect(release).toContain(`kb-${CLI_WINDOWS_TARGET}.zip`);
    expect(release).toContain("sha256sum --check --strict sha256.sum");
    expect(release).toMatch(/uses: actions\/attest@[0-9a-f]{40} /);
    expect(release).toContain("apps/cli/artifacts/sha256.sum");
  });
});

describe("install.sh rendering", () => {
  it("renders the release install, falling back to this version's tag, never a branch", () => {
    const text = installScript(ORIGIN, { kind: "release", baseUrl: `${RELEASE}/` });
    expect(text).toContain(`KB_RELEASE_URL='${RELEASE}'`);
    expect(text).toContain(`KB_VERSION='${SERVER_VERSION}'`);
    expect(text).toContain(`KB_ORIGIN='${ORIGIN}'`);
    expect(text).toContain(`install_source --tag 'v${SERVER_VERSION}'`);
    expect(text).toContain(`curl -fsSL ${ORIGIN}/install.sh | sh`);
    expect(text).not.toContain("--branch");
  });

  it("renders a source-only script for a pinned commit", () => {
    const text = installScript(ORIGIN, { kind: "source", rev: REV });
    expect(text).toContain("KB_RELEASE_URL=''");
    expect(text).toContain(`install_source --rev '${REV}'`);
    expect(text).not.toContain("install_source --tag");
  });

  it("asks for the loopback HTTP opt-in only for a plain-HTTP (development) origin", () => {
    expect(installScript(ORIGIN, cliInstallSource(undefined, undefined))).toContain(
      "KB_LOOPBACK_FLAG=''",
    );
    expect(
      installScript("http://127.0.0.1:3000", cliInstallSource(undefined, undefined)),
    ).toContain("KB_LOOPBACK_FLAG='--allow-loopback-http'");
  });

  it("serves an IPv6 literal origin", () => {
    const origin = "http://[::1]:3000";
    const source = cliInstallSource(undefined, undefined);
    expect(installScript(origin, source)).toContain(`KB_ORIGIN='${origin}'`);
    expect(windowsInstallScript(origin, source)).toContain(`$KbOrigin = '${origin}'`);
  });

  it("refuses to embed a value that could leave its quotes", () => {
    for (const baseUrl of ["https://x.example/'; rm -rf ~; '", "https://x.example/$(id)", "a b"]) {
      expect(() => installScript(ORIGIN, { kind: "release", baseUrl })).toThrow(/refusing/);
    }
    expect(() =>
      installScript("https://x.example/'", cliInstallSource(undefined, RELEASE)),
    ).toThrow(/refusing/);
  });

  it("parses as POSIX sh", () => {
    for (const source of [
      cliInstallSource(undefined, undefined),
      cliInstallSource(REV, undefined),
    ]) {
      for (const [shell, ...args] of [["sh"], ["dash"], ["bash", "--posix"], ["busybox", "sh"]]) {
        if (shell && has(shell)) {
          execFileSync(shell, [...args, "-n"], { input: installScript(ORIGIN, source) });
        }
      }
    }
  });
});

describe("install.ps1 rendering", () => {
  it("installs the release, then builds this version's tag where it does not run", () => {
    const text = windowsInstallScript(ORIGIN, { kind: "release", baseUrl: `${RELEASE}/` });
    expect(text).toContain(`$KbReleaseUrl = '${RELEASE}'`);
    expect(text).toContain(`$KbTarget = '${CLI_WINDOWS_TARGET}'`);
    expect(text).toContain(`$KbSourceArgs = @('--tag', 'v${SERVER_VERSION}')`);
    expect(text).toContain(`$KbOrigin = '${ORIGIN}'`);
    expect(text).toContain("$KbLoginArgs = @()");
    expect(text).toContain(`irm ${ORIGIN}/install.ps1 | iex`);
    expect(text).toContain("& $installed login --server $KbOrigin @KbLoginArgs");
    expect(text).not.toContain("--branch");
    // A failure never closes the window it runs in.
    expect(text).not.toMatch(/^\s*exit\b/m);
  });

  it("downloads over https only, on every redirect hop", () => {
    const text = windowsInstallScript(ORIGIN, { kind: "release", baseUrl: RELEASE });
    // Windows PowerShell 5.1's Invoke-WebRequest would follow https -> http.
    expect(text).not.toMatch(/Invoke-WebRequest -/);
    expect(text).toContain("$request.AllowAutoRedirect = $false");
    const loop = text.slice(text.indexOf("function Get-KbFile"));
    expect(loop.indexOf("StartsWith('https://'")).toBeLessThan(loop.indexOf("GetResponse()"));
    expect(text).toContain("[Net.SecurityProtocolType]::Tls12");
    // A relative CARGO_HOME: .NET would resolve it against the process directory.
    expect(loop).toContain("GetUnresolvedProviderPathFromPSPath($OutFile)");
  });

  it("checks the checksum entry before downloading the archive, and fails closed", () => {
    const text = windowsInstallScript(ORIGIN, { kind: "release", baseUrl: RELEASE });
    const entry = text.indexOf("sha256.sum has no checksum for $archive");
    expect(entry).toBeGreaterThan(0);
    expect(text.indexOf('Get-KbFile "$KbReleaseUrl/$archive" $zip')).toBeGreaterThan(entry);
    expect(text).toContain("if ($actual -ne $expected) {");
    expect(text).toContain("checksum mismatch for $archive");
  });

  it("builds a pinned commit from source without a release", () => {
    const pinned = windowsInstallScript(ORIGIN, { kind: "source", rev: REV });
    expect(pinned).toContain("$KbReleaseUrl = ''");
    expect(pinned).toContain(`$KbSourceArgs = @('--rev', '${REV}')`);
  });

  it("passes the loopback HTTP opt-in to a plain-HTTP origin", () => {
    expect(
      windowsInstallScript("http://127.0.0.1:3000", cliInstallSource(undefined, undefined)),
    ).toContain("$KbLoginArgs = @('--allow-loopback-http')");
  });

  it("refuses to embed a value that could leave its quotes", () => {
    for (const baseUrl of [
      "https://x.example/'; Remove-Item ~; '",
      "https://x.example/$(id)",
      "a b",
    ]) {
      expect(() => windowsInstallScript(ORIGIN, { kind: "release", baseUrl })).toThrow(/refusing/);
    }
  });

  const shells = ["pwsh", "powershell"].filter(
    (shell) =>
      spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0,
  );
  it.skipIf(shells.length === 0)("parses in every PowerShell here", { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-ps1-"));
    try {
      for (const source of [
        cliInstallSource(undefined, undefined),
        cliInstallSource(REV, undefined),
      ]) {
        const file = join(dir, "install.ps1");
        writeFileSync(file, windowsInstallScript(ORIGIN, source));
        for (const shell of shells) {
          const parsed = spawnSync(
            shell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$null = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath '${file}'))`,
            ],
            { encoding: "utf8" },
          );
          expect(parsed.status, `${shell}: ${parsed.stderr}`).toBe(0);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installer routes", () => {
  function app() {
    const hono = new Hono();
    registerCliInstallRoutes(hono);
    return hono;
  }

  it("serve the scripts for the canonical origin, uncached, whatever the request host", async () => {
    const headers = { host: "evil.example", "x-forwarded-host": "evil.example" };
    const sh = await app().request("/install.sh", { headers });
    expect(sh.status).toBe(200);
    expect(sh.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(sh.headers.get("cache-control")).toBe("no-store");
    const text = await sh.text();
    expect(text).toContain(`KB_ORIGIN='${ORIGIN}'`);
    expect(text).toContain(`KB_RELEASE_URL='${defaultCliReleaseBaseUrl()}'`);
    expect(text).not.toContain("evil.example");
    const ps1 = await app().request("/install.ps1", { headers });
    expect(ps1.status).toBe(200);
    expect(ps1.headers.get("cache-control")).toBe("no-store");
    expect(await ps1.text()).toContain(`$KbOrigin = '${ORIGIN}'`);
  });

  it("follow the release mirror and source pin settings", async () => {
    mockEnv.KB_CLI_RELEASE_BASE_URL = RELEASE;
    try {
      expect(await (await app().request("/install.sh")).text()).toContain(
        `KB_RELEASE_URL='${RELEASE}'`,
      );
      mockEnv.KB_CLI_SOURCE_REV = REV;
      const pinned = await (await app().request("/install.sh")).text();
      expect(pinned).toContain("KB_RELEASE_URL=''");
      expect(pinned).toContain(`install_source --rev '${REV}'`);
      expect(await (await app().request("/install.ps1")).text()).toContain(
        `$KbSourceArgs = @('--rev', '${REV}')`,
      );
    } finally {
      mockEnv.KB_CLI_RELEASE_BASE_URL = undefined;
      mockEnv.KB_CLI_SOURCE_REV = undefined;
    }
  });
});

type Machine = { os?: string; arch?: string; appleSilicon?: boolean };
type Fixture = {
  sums?: (sum: string, archive: string) => string | null;
  corrupt?: boolean;
  /** The archive's target (default x86_64 Linux). */
  target?: string;
  /** What the archive holds at kb-<target>/kb. */
  binary?: "ok" | "missing" | "broken";
};
type Options = {
  shell?: string;
  prepare?: (home: string) => void;
  /** Extra environment for the script, e.g. KB_INSTALL_NO_LOGIN. */
  env?: Record<string, string>;
  /** The stub kb's `login` exit status. */
  loginExit?: number;
};

const work = mkdtempSync(join(tmpdir(), "kb-install-test-"));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * The stub `kb`: records its arguments, and keeps `config set-server` in $HOME/kb-server so
 * `config show --json` prints it the way kb does (one compact JSON object).
 */
function stubKb(log: string): string {
  return `#!/bin/sh
echo "kb $*" >> '${log}'
case "$1" in
  --version) echo "kb 1.0.0" ;;
  config)
    case "$2" in
      show)
        if [ -f "$HOME/kb-server" ]; then printf '{"server":"%s"}\\n' "$(cat "$HOME/kb-server")"; else echo '{}'; fi ;;
      set-server) printf '%s' "$3" > "$HOME/kb-server"; echo "server set to $3" ;;
    esac ;;
  login)
    echo "open ${ORIGIN}/en-US/device?user_code=ABCD2345 and enter code ABCD-2345" >&2
    exit "\${KB_STUB_LOGIN_EXIT:-0}" ;;
esac
`;
}

let runs = 0;
/** Runs the rendered script in a fresh HOME with stub commands; returns output and what ran. */
function run(script: string, machine: Machine = {}, fixture: Fixture = {}, options: Options = {}) {
  const dir = join(work, `run-${++runs}`);
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  const release = join(dir, "release");
  const log = join(dir, "log");
  for (const d of [home, stubs, release]) mkdirSync(d, { recursive: true });
  writeFileSync(log, "");
  options.prepare?.(home);

  const target = fixture.target ?? "x86_64-unknown-linux-musl";
  const name = `kb-${target}.tar.xz`;
  mkdirSync(join(release, `kb-${target}`));
  const inside = fixture.binary === "missing" ? "README.md" : "kb";
  writeFileSync(
    join(release, `kb-${target}/${inside}`),
    fixture.binary === "broken" ? "#!/bin/sh\nexit 1\n" : stubKb(log),
    { mode: 0o755 },
  );
  execFileSync("tar", ["-cJf", name, `kb-${target}`], { cwd: release });
  const digest = createHash("sha256")
    .update(readFileSync(join(release, name)))
    .digest("hex");
  if (fixture.corrupt) writeFileSync(join(release, name), "tampered");
  const sums = fixture.sums
    ? fixture.sums(digest, name)
    : `${"0".repeat(64)} *source.tar.gz\n${digest} *${name}\n`;
  if (sums !== null) writeFileSync(join(release, "sha256.sum"), sums);

  const stub = (file: string, body: string) =>
    writeFileSync(join(stubs, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // curl ... -o DEST URL: serve RELEASE/<name> from the fixture directory, 22 when missing.
  stub(
    "curl",
    `echo "curl $*" >> '${log}'
dest=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) dest=$2; shift ;; *) url=$1 ;; esac
  shift
done
case "$url" in '${RELEASE}/'*) ;; *) exit 22 ;; esac
src='${release}'/\${url##*/}
[ -f "$src" ] || exit 22
cp "$src" "$dest"`,
  );
  stub(
    "uname",
    `case "$1" in -s) echo '${machine.os ?? "Linux"}' ;; -m) echo '${machine.arch ?? "x86_64"}' ;; esac`,
  );
  // A source build "installs" the stub kb into its --root, as cargo does (only there:
  // nothing else knows where it went).
  stub(
    "cargo",
    `echo "cargo $*" >> '${log}'
root=""
while [ $# -gt 0 ]; do
  case "$1" in --root) root=$2; shift ;; esac
  shift
done
[ -n "$root" ] || exit 0
mkdir -p "$root/bin"
cat > "$root/bin/kb" <<'KB'
${stubKb(log)}KB
chmod 755 "$root/bin/kb"`,
  );
  // hw.optional.arm64: 1 on Apple silicon (also under Rosetta), missing on Intel.
  stub("sysctl", machine.appleSilicon ? "echo 1" : "exit 1");

  const result = spawnSync(options.shell ?? "sh", [], {
    input: script,
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: `${stubs}:/usr/bin:/bin`,
      KB_STUB_LOGIN_EXIT: String(options.loginExit ?? 0),
      ...options.env,
    },
  });
  const installed = join(home, ".cargo/bin/kb");
  const calls = readFileSync(log, "utf8");
  return {
    home,
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls,
    kbCalls: calls.split("\n").filter((line) => line.startsWith("kb ") && line !== "kb --version"),
    installed: existsSync(installed) ? installed : null,
  };
}

const releaseScript = installScript(ORIGIN, { kind: "release", baseUrl: RELEASE });
const canRun = has("xz") && has("tar") && has("awk");

describe.skipIf(!canRun)("install.sh behavior", () => {
  it("installs the verified binary into ~/.cargo/bin, sets the server and logs in", () => {
    for (const shell of ["sh", "dash"].filter(has)) {
      const out = run(releaseScript, {}, {}, { shell });
      expect(out.output).toContain("checksum verified");
      expect(out.status).toBe(0);
      expect(out.installed).not.toBeNull();
      expect(out.calls).toContain(`${RELEASE}/sha256.sum`);
      expect(out.calls).toContain(`${RELEASE}/kb-x86_64-unknown-linux-musl.tar.xz`);
      expect(out.calls).toContain("curl --proto =https --tlsv1.2 ");
      expect(out.calls).not.toMatch(/^cargo /m);
      // ~/.cargo/bin is not on this PATH: the script says how to run it.
      expect(out.output).toContain("is not on your PATH");
      expect(out.kbCalls).toEqual([
        "kb config show --json",
        `kb config set-server ${ORIGIN}`,
        `kb login --server ${ORIGIN}`,
      ]);
      expect(out.output).toContain(`default server set to ${ORIGIN}`);
      expect(out.output).toContain("enter code ABCD-2345");
    }
  });

  it("keeps another configured server and still logs in to this one", () => {
    const out = run(
      releaseScript,
      {},
      {},
      {
        prepare: (home) => writeFileSync(join(home, "kb-server"), "https://other.example.com"),
      },
    );
    expect(out.status).toBe(0);
    expect(out.kbCalls).toEqual(["kb config show --json", `kb login --server ${ORIGIN}`]);
    expect(out.output).toContain("default server stays https://other.example.com");
  });

  it("does not set the server again when it is already this one", () => {
    const out = run(
      releaseScript,
      {},
      {},
      {
        prepare: (home) => writeFileSync(join(home, "kb-server"), ORIGIN),
      },
    );
    expect(out.status).toBe(0);
    expect(out.kbCalls).toEqual(["kb config show --json", `kb login --server ${ORIGIN}`]);
  });

  it("passes the loopback opt-in to a plain-HTTP development origin", () => {
    const dev = "http://127.0.0.1:3000";
    const out = run(installScript(dev, { kind: "release", baseUrl: RELEASE }));
    expect(out.status).toBe(0);
    expect(out.kbCalls).toEqual([
      "kb config show --json",
      `kb config set-server ${dev} --allow-loopback-http`,
      `kb login --server ${dev} --allow-loopback-http`,
    ]);
  });

  it("installs without logging in when KB_INSTALL_NO_LOGIN is set", () => {
    const out = run(releaseScript, {}, {}, { env: { KB_INSTALL_NO_LOGIN: "1" } });
    expect(out.status).toBe(0);
    expect(out.installed).not.toBeNull();
    expect(out.kbCalls).toEqual([]);
    expect(out.output).toContain(`later run: kb login --server ${ORIGIN}`);
  });

  it("keeps the install but fails when login does not finish", () => {
    const out = run(releaseScript, {}, {}, { loginExit: 1 });
    expect(out.status).not.toBe(0);
    expect(out.installed).not.toBeNull();
    expect(out.output).toContain("kb is installed, but login did not finish");
  });

  it("maps arm64 to the aarch64 archive", () => {
    const target = "aarch64-unknown-linux-musl";
    const out = run(releaseScript, { arch: "arm64" }, { target });
    expect(out.calls).toContain(`${RELEASE}/kb-${target}.tar.xz`);
    expect(out.status).toBe(0);
    expect(out.installed).not.toBeNull();
  });

  it("installs the native build on macOS, also from a Rosetta shell", () => {
    const machines: [Machine, string][] = [
      [{ os: "Darwin", arch: "arm64", appleSilicon: true }, "aarch64-apple-darwin"],
      [{ os: "Darwin", arch: "x86_64", appleSilicon: true }, "aarch64-apple-darwin"],
      [{ os: "Darwin", arch: "x86_64" }, "x86_64-apple-darwin"],
    ];
    for (const [machine, target] of machines) {
      const out = run(releaseScript, machine, { target });
      expect(out.calls).toContain(`${RELEASE}/kb-${target}.tar.xz`);
      expect(out.status).toBe(0);
      expect(out.installed).not.toBeNull();
    }
  });

  it("fails closed on a checksum mismatch", () => {
    const out = run(releaseScript, {}, { corrupt: true });
    expect(out.status).not.toBe(0);
    expect(out.output).toContain("checksum mismatch");
    expect(out.installed).toBeNull();
    expect(out.calls).not.toMatch(/^cargo /m);
    expect(out.kbCalls).toEqual([]);
  });

  it("fails closed when sha256.sum is missing, lacks the archive, or is malformed", () => {
    const cases: Fixture["sums"][] = [
      () => null,
      () => `${"a".repeat(64)} *kb-aarch64-unknown-linux-musl.tar.xz\n`,
      (sum, archive) => `${sum.slice(1)} *${archive}\n`,
      (sum, archive) => `${sum.replace(/^./, "g")} *${archive}\n`,
      (sum, archive) => `${sum} *other-${archive}\n`,
      (_sum, archive) => `*${archive}\n`,
      () => "",
    ];
    for (const sums of cases) {
      const out = run(releaseScript, {}, { sums });
      expect(out.status).not.toBe(0);
      expect(out.installed).toBeNull();
      expect(out.calls).not.toMatch(/^cargo /m);
      // Without a usable checksum entry, the archive is never even downloaded.
      expect(out.calls).not.toContain(".tar.xz");
    }
  });

  it("accepts a text-mode line, CRLF and upper-case hex in sha256.sum", () => {
    for (const sums of [
      (sum: string, archive: string) => `${sum}  ${archive}\n`,
      (sum: string, archive: string) => `${sum.toUpperCase()} *${archive}\r\n`,
    ]) {
      const out = run(releaseScript, {}, { sums });
      expect(out.status).toBe(0);
      expect(out.installed).not.toBeNull();
    }
  });

  it("stops, without building from source, when the release is not published", () => {
    const out = run(releaseScript, {}, { sums: () => null });
    expect(out.status).not.toBe(0);
    expect(out.output).toContain(`could not download ${RELEASE}/sha256.sum`);
    expect(out.calls).not.toMatch(/^cargo /m);
  });

  it("refuses an archive without kb in it, or a kb that does not run here", () => {
    const missing = run(releaseScript, {}, { binary: "missing" });
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain("does not contain");
    expect(missing.installed).toBeNull();
    const broken = run(releaseScript, {}, { binary: "broken" });
    expect(broken.status).not.toBe(0);
    expect(broken.output).toContain("does not run on this machine");
    expect(broken.installed).toBeNull();
  });

  it("leaves no staging directory behind", () => {
    for (const fixture of [{}, { corrupt: true }, { binary: "missing" as const }]) {
      const out = run(releaseScript, {}, fixture);
      const bin = join(out.home, ".cargo/bin");
      const left = existsSync(bin) ? readdirSync(bin).filter((name) => name !== "kb") : [];
      expect(left).toEqual([]);
    }
  });

  it("stops before installing anywhere when neither HOME nor CARGO_HOME is set", () => {
    for (const machine of [{}, { arch: "riscv64" }] as Machine[]) {
      const out = run(releaseScript, machine, {}, { env: { HOME: "" } });
      expect(out.status).not.toBe(0);
      expect(out.output).toContain("set HOME (or CARGO_HOME), then run this again.");
      expect(out.output).not.toContain("downloading kb");
      expect(out.calls).not.toMatch(/^(curl|cargo) /m);
    }
  });

  it("refuses to install over a directory", () => {
    const out = run(
      releaseScript,
      {},
      {},
      {
        prepare: (home) => mkdirSync(join(home, ".cargo/bin/kb"), { recursive: true }),
      },
    );
    expect(out.status).not.toBe(0);
    expect(out.output).toContain("is a directory");
    expect(existsSync(join(out.home, ".cargo/bin/kb/kb"))).toBe(false);
  });

  it("builds this version's tag from source where no binary fits, then logs in", () => {
    for (const machine of [{ arch: "riscv64" }, { os: "FreeBSD" }] as Machine[]) {
      const out = run(releaseScript, machine);
      expect(out.status).toBe(0);
      expect(out.output).toContain("building from source instead");
      expect(out.calls).toMatch(
        new RegExp(
          `^cargo install --git ${CLI_REPOSITORY} --tag v${SERVER_VERSION.replaceAll(".", "\\.")} --locked --force --root ${out.home}/\\.cargo kb$`,
          "m",
        ),
      );
      expect(out.installed).not.toBeNull();
      expect(out.calls).not.toContain("curl ");
      expect(out.kbCalls.at(-1)).toBe(`kb login --server ${ORIGIN}`);
    }
  });

  it("builds the pinned commit and never downloads when KB_CLI_SOURCE_REV is set", () => {
    const out = run(installScript(ORIGIN, cliInstallSource(REV, RELEASE)));
    expect(out.status).toBe(0);
    expect(out.calls).toMatch(
      new RegExp(
        `^cargo install --git ${CLI_REPOSITORY} --rev ${REV} --locked --force --root \\S+ kb$`,
        "m",
      ),
    );
    expect(out.calls).not.toContain("curl ");
    expect(out.installed).not.toBeNull();
  });

  it("installs a source build into CARGO_INSTALL_ROOT and runs that kb", () => {
    const script = installScript(ORIGIN, cliInstallSource(REV, RELEASE));
    const out = run(
      script,
      {},
      {},
      {
        prepare: (home) => mkdirSync(join(home, "root")),
        env: { CARGO_INSTALL_ROOT: join(work, `run-${runs + 1}`, "home", "root") },
      },
    );
    const root = join(out.home, "root");
    expect(out.status).toBe(0);
    expect(out.calls).toContain(`--locked --force --root ${root} kb`);
    expect(out.output).toContain(`installed ${root}/bin/kb.`);
    expect(out.installed).toBeNull();
    expect(out.kbCalls.at(-1)).toBe(`kb login --server ${ORIGIN}`);
  });
});
