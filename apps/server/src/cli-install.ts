/**
 * The `kb` CLI installers this server serves, so one command connects a new
 * machine to it:
 *
 * - `GET /install.sh` (`curl -fsSL <origin>/install.sh | sh`): Linux and macOS.
 * - `GET /install.ps1` (`irm <origin>/install.ps1 | iex`): Windows.
 *
 * Both install the `kb` release of this server's version ({@link SERVER_VERSION}),
 * verified against the release's `sha256.sum` (fail closed: no checksum file, no
 * entry, a malformed entry, no hashing tool or a mismatch installs nothing), into
 * cargo's bin directory (`$CARGO_HOME/bin`, else `~/.cargo/bin`), where the
 * release's cargo-dist installers (`install-path = "CARGO_HOME"`) and a source
 * build put it too. Where no release binary fits, or when the server pins a
 * commit (`KB_CLI_SOURCE_REV`), they build from source with cargo. Then they
 * point `kb` at this server (when no other server is configured) and run
 * `kb login`: the browser-approved device flow.
 */

import { env } from "@knowledge-base/env/server";
import type { Env, Hono } from "hono";
import { SERVER_VERSION } from "./version.js";

/** Where the CLI's source and GitHub Releases live. */
export const CLI_REPOSITORY = "https://github.com/FlyCockpit/knowledge-base";

/**
 * The Unix release targets `/install.sh` downloads (`kb-<target>.tar.xz`, listed in
 * `sha256.sum`; apps/cli/dist-workspace.toml builds them). Linux always gets the
 * static musl build: it runs on any glibc or musl system.
 */
export const CLI_RELEASE_TARGETS = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
] as const;

/**
 * The Windows release target `/install.ps1` downloads (`kb-<target>.zip`, listed in
 * `sha256.sum`). Windows 11 on ARM64 runs it under x64 emulation.
 */
export const CLI_WINDOWS_TARGET = "x86_64-pc-windows-msvc";

/** The GitHub Release of this server's version. */
export function defaultCliReleaseBaseUrl(): string {
  return `${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}`;
}

/**
 * What the installers install. `release`: the checksummed binary for the machine
 * from `baseUrl`, or a cargo build of this version's tag where no binary fits.
 * `source`: always a cargo build of the pinned commit.
 */
export type CliInstallSource =
  | { kind: "release"; baseUrl: string }
  | { kind: "source"; rev: string };

/** `KB_CLI_SOURCE_REV` wins, then `KB_CLI_RELEASE_BASE_URL`, then this version's GitHub Release. */
export function cliInstallSource(
  rev: string | undefined,
  releaseBaseUrl: string | undefined,
): CliInstallSource {
  if (rev) return { kind: "source", rev };
  return { kind: "release", baseUrl: releaseBaseUrl ?? defaultCliReleaseBaseUrl() };
}

// Values are embedded in single quotes; refuse anything that could leave them.
// Brackets are allowed for an IPv6 literal origin (\`http://[::1]:3000\`).
function quoted(value: string): string {
  if (!/^[A-Za-z0-9._~%+@:/=[\]-]*$/.test(value)) {
    throw new Error(`kb installer: refusing to embed ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

/** The server origin the installers log in to: the canonical `BETTER_AUTH_URL` origin. */
function canonicalOrigin(): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * `kb` refuses plain HTTP except for a loopback development server, and then only
 * with this flag (apps/cli/src/auth.rs). Any other `http://` origin fails at login.
 */
function loopbackFlag(origin: string): string {
  return origin.startsWith("http://") ? "--allow-loopback-http" : "";
}

/**
 * The POSIX installer. Everything runs from `main` on the last line, so a download
 * cut short runs nothing.
 */
export function installScript(origin: string, source: CliInstallSource): string {
  const releaseUrl = source.kind === "release" ? source.baseUrl.replace(/\/+$/, "") : "";
  const sourceArgs =
    source.kind === "release"
      ? `--tag ${quoted(`v${SERVER_VERSION}`)}`
      : `--rev ${quoted(source.rev)}`;
  const summary =
    source.kind === "source"
      ? `# Builds kb from source with cargo at commit ${source.rev} (KB_CLI_SOURCE_REV).`
      : `# Installs the checksummed kb ${SERVER_VERSION} release binary for this machine, or builds\n# v${SERVER_VERSION} from source with cargo where no binary fits.`;
  return `#!/bin/sh
# knowledge-base CLI (kb) installer for ${origin}
${summary}
# Then it logs kb in to this server (browser approval).
# Run it: curl -fsSL ${origin}/install.sh | sh
# Set KB_INSTALL_NO_LOGIN=1 to install without logging in.
set -eu

KB_VERSION=${quoted(SERVER_VERSION)}
KB_RELEASE_URL=${quoted(releaseUrl)}
KB_REPOSITORY=${quoted(CLI_REPOSITORY)}
KB_ORIGIN=${quoted(origin)}
KB_LOOPBACK_FLAG=${quoted(loopbackFlag(origin))}

say() { printf 'kb: %s\\n' "$*"; }
die() { printf 'kb: %s\\n' "$*" >&2; exit 1; }

# cargo's bin directory. Under \`set -u\` an unset HOME would abort with a shell error: say why.
cargo_home() {
  [ -n "\${CARGO_HOME:-}" ] || [ -n "\${HOME:-}" ] || die "set HOME (or CARGO_HOME), then run this again."
  printf '%s' "\${CARGO_HOME:-$HOME/.cargo}"
}
# A failure must stop the caller: \`printf "$(cargo_home)"\` would succeed with "/bin".
bin_dir() {
  home=$(cargo_home) || exit 1
  printf '%s/bin' "$home"
}

# The release target for this machine, or nothing when no release binary runs here.
detect_target() {
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) return 0 ;;
  esac
  case "$(uname -s)" in
    # Static musl: runs on any glibc or musl (Alpine) system.
    Linux) printf '%s-unknown-linux-musl' "$arch" ;;
    Darwin)
      # A Rosetta shell reports x86_64 on Apple silicon: install the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
        arch=aarch64
      fi
      printf '%s-apple-darwin' "$arch"
      ;;
  esac
}

# curl only: wget cannot refuse a redirect away from https for a single download.
fetch() {
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1"
  else
    return 1
  fi
}

install_release() {
  target=$1
  archive="kb-$target.tar.xz"
  command -v curl >/dev/null 2>&1 || die "curl is needed to download kb."
  dir=$(bin_dir)
  mkdir -p "$dir"
  # Staged beside the install directory, not in /tmp: the binary is test-run before it is
  # installed (a noexec /tmp would refuse that), and the final rename stays on one filesystem.
  tmp=$(mktemp -d "$dir/.kb-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  say "downloading kb $KB_VERSION for $target from $KB_RELEASE_URL..."
  fetch "$KB_RELEASE_URL/sha256.sum" "$tmp/sha256.sum" ||
    die "could not download $KB_RELEASE_URL/sha256.sum (is kb $KB_VERSION published there?)."
  expected=$(awk -v f="$archive" '{ sub(/\\r$/, "") } $2 == f || $2 == "*" f { print tolower($1); exit }' "$tmp/sha256.sum")
  case "$expected" in
    "" | *[!0-9a-f]*) die "sha256.sum has no checksum for $archive; not installing it." ;;
  esac
  [ \${#expected} -eq 64 ] || die "sha256.sum has no checksum for $archive; not installing it."
  fetch "$KB_RELEASE_URL/$archive" "$tmp/$archive" ||
    die "could not download $KB_RELEASE_URL/$archive."
  actual=$(sha256_of "$tmp/$archive" | awk '{ print tolower($1) }')
  [ -n "$actual" ] ||
    die "no SHA-256 tool (sha256sum, shasum or openssl) found; not installing an unverified binary."
  [ "$actual" = "$expected" ] ||
    die "checksum mismatch for $archive (expected $expected, got $actual); not installing it."
  say "checksum verified ($expected)."
  (cd "$tmp" && tar -xJf "$archive") ||
    die "could not unpack $archive (tar needs xz: install xz-utils)."
  binary="$tmp/kb-$target/kb"
  [ -f "$binary" ] && [ ! -L "$binary" ] || die "$archive does not contain kb-$target/kb."
  "$binary" --version >/dev/null 2>&1 ||
    die "the downloaded kb does not run on this machine; build it from source instead: cargo install --git $KB_REPOSITORY ${sourceArgs} --locked kb"
  [ ! -d "$dir/kb" ] || die "$dir/kb is a directory; remove it, then run this again."
  # Rename over the old binary: a running kb keeps its old file.
  chmod 755 "$binary" && mv -f "$binary" "$dir/kb" || die "could not install into $dir."
  installed="$dir/kb"
}

# A non-interactive SSH shell skips the profile that puts rustup's cargo on PATH: source
# rustup's env file, and keep looking past one that does not provide cargo.
find_cargo() {
  command -v cargo >/dev/null 2>&1 && return 0
  for cargo_env in "\${CARGO_HOME:-}/env" "\${HOME:-}/.cargo/env"; do
    if [ "$cargo_env" != "/env" ] && [ "$cargo_env" != "/.cargo/env" ] && [ -f "$cargo_env" ]; then
      set +eu
      . "$cargo_env"
      set -eu
      command -v cargo >/dev/null 2>&1 && return 0
    fi
  done
  return 0
}

install_source() {
  find_cargo
  command -v cargo >/dev/null 2>&1 ||
    die "cargo is not installed. Install Rust 1.96 or newer from https://rustup.rs, plus Git, CMake, a C++ compiler, libclang and OpenMP, then run this again."
  say "building kb from $KB_REPOSITORY ($*) with cargo; this takes several minutes..."
  root=\${CARGO_INSTALL_ROOT:-}
  [ -n "$root" ] || root=$(cargo_home)
  # An explicit --root: cargo's \`install.root\` config would otherwise put kb elsewhere.
  cargo install --git "$KB_REPOSITORY" "$@" --locked --force --root "$root" kb
  installed="$root/bin/kb"
}

finish() {
  dir=\${installed%/kb}
  say "installed $installed."
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "$dir is not on your PATH: run \\"$dir/kb\\", or add it to PATH." ;;
  esac
  found=$(command -v kb 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$installed" ]; then
    say "warning: $found comes first on your PATH (an older kb); remove it."
  fi
}

# Point kb at this server unless it already uses another one, then log in.
connect() {
  if [ -n "\${KB_INSTALL_NO_LOGIN:-}" ]; then
    say "not logging in (KB_INSTALL_NO_LOGIN is set); later run: kb login --server $KB_ORIGIN $KB_LOOPBACK_FLAG"
    return 0
  fi
  if configured=$("$installed" config show --json 2>/dev/null); then
    # \`config show --json\` is one JSON object; a quote inside a value is escaped, so only the
    # real key matches \`"server"\`.
    current=$(printf '%s\\n' "$configured" | sed -n 's/.*"server"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    if [ -z "$current" ]; then
      "$installed" config set-server "$KB_ORIGIN" $KB_LOOPBACK_FLAG >/dev/null ||
        die "kb is installed, but could not set its server; run: kb config set-server $KB_ORIGIN $KB_LOOPBACK_FLAG"
      say "default server set to $KB_ORIGIN."
    elif [ "$current" != "$KB_ORIGIN" ]; then
      say "kb's default server stays $current; to switch, run: kb config set-server $KB_ORIGIN"
    fi
  else
    say "warning: could not read kb's config (run: kb config show); logging in without changing it."
  fi
  say "logging in to $KB_ORIGIN: open the link below in a browser, sign in and approve this device."
  "$installed" login --server "$KB_ORIGIN" $KB_LOOPBACK_FLAG </dev/null ||
    die "kb is installed, but login did not finish; run: kb login --server $KB_ORIGIN $KB_LOOPBACK_FLAG"
}

main() {
  installed=""
  if [ -z "$KB_RELEASE_URL" ]; then
    install_source ${sourceArgs}
  else
    target=$(detect_target)
    if [ -n "$target" ]; then
      install_release "$target"
    else
      say "no kb release binary fits this machine ($(uname -s) $(uname -m)); building from source instead."
      install_source ${sourceArgs}
    fi
  fi
  finish
  connect
}

main "$@"
`;
}

/**
 * The PowerShell installer, for Windows PowerShell 5.1 and PowerShell 7: the
 * counterpart of {@link installScript}. Everything runs in one script block, so a
 * download cut short does not parse and runs nothing. A failure throws (never
 * `exit`, which would close the PowerShell window it runs in), which also stops a
 * command after `iex` on the same line.
 */
export function windowsInstallScript(origin: string, source: CliInstallSource): string {
  const releaseUrl = source.kind === "release" ? source.baseUrl.replace(/\/+$/, "") : "";
  const sourceArgs =
    source.kind === "release"
      ? `'--tag', ${quoted(`v${SERVER_VERSION}`)}`
      : `'--rev', ${quoted(source.rev)}`;
  const sourceHint = sourceArgs.replaceAll("'", "").replace(",", "");
  const summary =
    source.kind === "source"
      ? `# Builds kb from source with cargo at commit ${source.rev} (KB_CLI_SOURCE_REV).`
      : `# Installs the checksummed kb ${SERVER_VERSION} release binary for Windows, or builds\n# v${SERVER_VERSION} from source with cargo where it does not run.`;
  const loopback = loopbackFlag(origin);
  return `# knowledge-base CLI (kb) installer for ${origin}
${summary}
# Then it logs kb in to this server (browser approval).
# Run it in PowerShell: irm ${origin}/install.ps1 | iex
# Set $env:KB_INSTALL_NO_LOGIN = '1' to install without logging in.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 on an older .NET default may not offer TLS 1.2, which GitHub requires.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$KbVersion = ${quoted(SERVER_VERSION)}
$KbReleaseUrl = ${quoted(releaseUrl)}
$KbRepository = ${quoted(CLI_REPOSITORY)}
$KbTarget = ${quoted(CLI_WINDOWS_TARGET)}
$KbSourceArgs = @(${sourceArgs})
$KbOrigin = ${quoted(origin)}
$KbLoginArgs = @(${loopback ? quoted(loopback) : ""})

function Say([string]$Text) { Write-Host "kb: $Text" }

# cargo's home: its bin directory is where cargo puts a source build, so the two never leave two copies.
function Get-CargoHome {
  if ($env:CARGO_HOME) { return $env:CARGO_HOME }
  if (-not $env:USERPROFILE) { throw 'kb: set USERPROFILE (or CARGO_HOME), then run this again.' }
  Join-Path $env:USERPROFILE '.cargo'
}

# Downloads follow redirects by hand so every hop stays on https: Windows PowerShell 5.1's
# Invoke-WebRequest would follow an https -> http redirect, letting a network attacker swap
# the archive and sha256.sum together.
function Get-KbFile([string]$Url, [string]$OutFile) {
  # .NET resolves a relative path against the process directory, not PowerShell's location.
  $OutFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
  for ($hop = 0; $hop -le 10; $hop++) {
    if (-not $Url.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
      throw "kb: refusing to download from $Url (https only)."
    }
    $request = [Net.WebRequest]::Create($Url)
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'kb-install'
    $response = $null
    try { $response = $request.GetResponse() } catch {
      $e = $_.Exception
      while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
      if ($e -and $e.Response) { $response = $e.Response } else { throw }
    }
    try {
      $status = [int]$response.StatusCode
      if ($status -ge 300 -and $status -lt 400) {
        $location = $response.Headers['Location']
        if (-not $location) { throw "kb: $Url redirected without a location." }
        $Url = (New-Object Uri ([Uri]$Url), $location).AbsoluteUri
        continue
      }
      if ($status -ne 200) { throw "kb: $Url answered HTTP $status." }
      $body = $response.GetResponseStream()
      $file = [IO.File]::Create($OutFile)
      try { $body.CopyTo($file) } finally { $file.Dispose(); $body.Dispose() }
      return
    } finally {
      $response.Dispose()
    }
  }
  throw "kb: too many redirects downloading $Url."
}

function Install-Release {
  # Absolute, so a relative CARGO_HOME means the same directory to PowerShell and .NET.
  $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Join-Path (Get-CargoHome) 'bin'))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Copies an earlier install renamed out of the way while it ran, now free to go.
  Get-ChildItem -LiteralPath $dir -Filter '.kb-old.*' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  $tmp = Join-Path $dir ('.kb-install.' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $archive = "kb-$KbTarget.zip"
    Say "downloading kb $KbVersion for $KbTarget from $KbReleaseUrl..."
    $sums = Join-Path $tmp 'sha256.sum'
    try { Get-KbFile "$KbReleaseUrl/sha256.sum" $sums } catch {
      throw "kb: could not download $KbReleaseUrl/sha256.sum (is kb $KbVersion published there?): $($_.Exception.Message)"
    }
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $fields = @($line.Trim() -split '\\s+')
      if ($fields.Count -ge 2 -and ($fields[1] -ceq $archive -or $fields[1] -ceq "*$archive")) {
        $expected = $fields[0].ToLowerInvariant()
        break
      }
    }
    if ($expected -notmatch '^[0-9a-f]{64}$') {
      throw "kb: sha256.sum has no checksum for $archive; not installing it."
    }
    $zip = Join-Path $tmp $archive
    try { Get-KbFile "$KbReleaseUrl/$archive" $zip } catch {
      throw "kb: could not download $KbReleaseUrl/$($archive): $($_.Exception.Message)"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "kb: checksum mismatch for $archive (expected $expected, got $actual); not installing it."
    }
    Say "checksum verified ($expected)."
    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $binary = @((Join-Path $unpacked 'kb.exe'), (Join-Path $unpacked "kb-$KbTarget\\kb.exe")) |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $binary) { throw "kb: $archive does not contain kb.exe." }
    $runs = $false
    try { & $binary --version *> $null; $runs = $LASTEXITCODE -eq 0 } catch { $runs = $false }
    if (-not $runs) {
      throw "kb: the downloaded kb does not run on this machine; build it from source instead: cargo install --git $KbRepository ${sourceHint} --locked kb"
    }
    $installed = Join-Path $dir 'kb.exe'
    if (Test-Path -LiteralPath $installed -PathType Container) {
      throw "kb: $installed is a directory; remove it, then run this again."
    }
    # A running kb.exe (an MCP client's server) cannot be replaced, but it can be renamed out of the way.
    if (Test-Path -LiteralPath $installed) {
      $old = Join-Path $dir ('.kb-old.' + [IO.Path]::GetRandomFileName())
      Move-Item -LiteralPath $installed -Destination $old
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $binary -Destination $installed
    $installed
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-Source {
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $cargo) {
    $candidate = Join-Path (Get-CargoHome) 'bin\\cargo.exe'
    if (Test-Path -LiteralPath $candidate) { $cargo = $candidate }
  }
  if (-not $cargo) {
    throw 'kb: cargo is not installed. Install Rust 1.96 or newer from https://rustup.rs (with the Visual Studio C++ build tools), Git, CMake and LLVM (libclang), then run this again.'
  }
  Say "building kb from $KbRepository ($($KbSourceArgs -join ' ')) with cargo; this takes several minutes..."
  $root = if ($env:CARGO_INSTALL_ROOT) { $env:CARGO_INSTALL_ROOT } else { Get-CargoHome }
  $root = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($root)
  # An explicit --root: cargo's \`install.root\` config would otherwise put kb elsewhere.
  & $cargo install --git $KbRepository @KbSourceArgs --locked --force --root $root kb
  if ($LASTEXITCODE -ne 0) { throw 'kb: cargo install failed.' }
  Join-Path $root 'bin\\kb.exe'
}

$installed = $null
if (-not $KbReleaseUrl) {
  $installed = Install-Source
} elseif ($env:PROCESSOR_ARCHITECTURE -in @('AMD64', 'ARM64')) {
  $installed = Install-Release
} else {
  Say "no kb release binary fits this machine ($env:PROCESSOR_ARCHITECTURE); building from source instead."
  $installed = Install-Source
}
$dir = Split-Path -Parent $installed
Say "installed $installed."
if (-not (@($env:Path -split ';') -contains $dir)) {
  Say "$dir is not on your PATH: run \`"$installed\`", or add it to PATH."
}
$found = Get-Command kb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found -and $found.Source -ne $installed) {
  Say "warning: $($found.Source) comes first on your PATH (an older kb); remove it."
}

# Point kb at this server unless it already uses another one, then log in.
$retry = (@('kb', 'login', '--server', $KbOrigin) + $KbLoginArgs) -join ' '
if ($env:KB_INSTALL_NO_LOGIN) {
  Say "not logging in (KB_INSTALL_NO_LOGIN is set); later run: $retry"
} else {
  $current = $null
  $readable = $true
  try {
    $json = (& $installed config show --json 2>$null) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) { $readable = $false } else { $current = ($json | ConvertFrom-Json).server }
  } catch { $readable = $false }
  if (-not $readable) {
    Say "warning: could not read kb's config (run: kb config show); logging in without changing it."
  } elseif (-not $current) {
    & $installed config set-server $KbOrigin @KbLoginArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "kb: kb is installed, but could not set its server; run: kb config set-server $KbOrigin" }
    Say "default server set to $KbOrigin."
  } elseif ($current -ne $KbOrigin) {
    Say "kb's default server stays $current; to switch, run: kb config set-server $KbOrigin"
  }
  Say "logging in to $($KbOrigin): open the link below in a browser, sign in and approve this device."
  & $installed login --server $KbOrigin @KbLoginArgs
  if ($LASTEXITCODE -ne 0) { throw "kb: kb is installed, but login did not finish; run: $retry" }
}
}
`;
}

/**
 * `GET /install.sh` and `GET /install.ps1`. Public by design (they hold no secret
 * and run nothing on the server); never cached, so a redeploy's version applies at once.
 */
export function registerCliInstallRoutes<E extends Env>(app: Hono<E>): Hono<E> {
  const source = () => cliInstallSource(env.KB_CLI_SOURCE_REV, env.KB_CLI_RELEASE_BASE_URL);
  app.get("/install.sh", (c) =>
    c.body(installScript(canonicalOrigin(), source()), 200, {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  );
  app.get("/install.ps1", (c) =>
    c.body(windowsInstallScript(canonicalOrigin(), source()), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  );
  return app;
}
