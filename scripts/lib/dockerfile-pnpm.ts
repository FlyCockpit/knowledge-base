/**
 * pnpm toolchain lint for the Dockerfiles (`pnpm docker:check-copy`).
 *
 * Threat model: Dockerfile authors are trusted committers. This lint is a
 * CONVENIENCE GUARD against accidental regressions only, not a security
 * boundary, and it is deliberately not a shell or Dockerfile interpreter.
 * The authoritative check is scripts/lib/dev-toolchain-check.sh, which
 * `pnpm dev:docker` runs against the image actually built, as the runtime UID
 * and offline: it inspects the real file tree, so heredocs, unused stages,
 * absolute tool paths or WORKDIR tricks cannot fool it.
 *
 * What the lint does reliably:
 * - packageManager and every pnpm pin are the anchored full `pnpm@x.y.z+sha512.<128 hex>`;
 * - one canonical toolchain RUN per Dockerfile, as a real instruction (not in
 *   a heredoc): install exact-pinned Corepack from npm (Node 25+ does not bundle
 *   it), enable pnpm, prepare the integrity-pinned wrapper and warm its native
 *   binary at build time; in Dockerfile.dev it must be in the final stage (the
 *   one the dev compose services run); any other RUN mentioning corepack, any
 *   other pin, and any heredoc RUN mentioning corepack/pnpm fails;
 * - best effort: in the stage holding the toolchain RUN, a chmod/chown/chgrp
 *   (matched by basename) whose target is a relative path, the toolchain, one
 *   of its ancestors, or inside it (except $PNPM_HOME/store) fails, and so
 *   does a COPY/ADD --chown/--chmod whose destination is the toolchain, an
 *   ancestor or inside it.
 */

/** The only accepted pin form, in package.json and in every Dockerfile. */
export const PNPM_PIN = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[0-9a-f]{128}$/;

/** Newest stable Corepack published by the upgrade's 2026-10-28 cutoff. */
export const COREPACK_VERSION = "0.36.0";

/** The canonical toolchain step; only the pin and its version vary. */
export function canonicalPnpmRun(packageManager: string): string {
  const version = PNPM_PIN.exec(packageManager)?.[1];
  if (!version) throw new Error(`not a full pnpm pin: ${packageManager}`);
  return (
    `RUN npm install --global --no-fund --no-audit corepack@${COREPACK_VERSION} && ` +
    'mkdir -p "$PNPM_HOME" && corepack enable --install-directory "$PNPM_HOME" pnpm && ' +
    `corepack prepare ${packageManager} --activate && test "$(pnpm --version)" = "${version}"`
  );
}

/** Toolchain-relative paths a Dockerfile may change permissions of. */
const MUTABLE_ALLOWLIST = ["$PNPM_HOME/store"];
const PERMISSION_TOOLS = new Set(["chmod", "chown", "chgrp"]);
const SEPARATORS = new Set(["&&", "||", ";", "|"]);

type Instruction = { keyword: string; text: string; line: number; heredoc: boolean };

/**
 * Logical instructions: Docker comment lines dropped, `\` continuations joined,
 * heredoc bodies (`<<WORD`, `<<-WORD`, quoted) skipped and the instruction marked.
 */
function instructions(lines: string[]): Instruction[] {
  const out: Instruction[] = [];
  let parts: string[] | null = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*#/.test(raw)) continue;
    if (parts === null) {
      if (raw.trim() === "") continue;
      parts = [];
      start = i + 1;
    }
    const continued = /\\\s*$/.test(raw);
    parts.push(continued ? raw.replace(/\\\s*$/, "") : raw);
    if (continued) continue;
    const text = parts.join(" ").trim();
    parts = null;
    const words = [...text.matchAll(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g)].map((m) => m[1]);
    const bodies: string[] = [];
    for (const word of words) {
      while (i + 1 < lines.length && (lines[i + 1] ?? "").trim() !== word)
        bodies.push(lines[++i] ?? "");
      i++;
    }
    out.push({
      keyword: (/^(\S+)/.exec(text)?.[1] ?? "").toUpperCase(),
      text: [text, ...bodies].join("\n"),
      line: start,
      heredoc: words.length > 0,
    });
  }
  return out;
}

const unquote = (token: string) => token.replace(/^["']|["']$/g, "");
const normalize = (path: string) => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};

export function pnpmToolchainErrors(
  dockerfile: string,
  text: string,
  packageManager: string,
): string[] {
  if (!PNPM_PIN.test(packageManager))
    return [`package.json packageManager ${packageManager} is not pnpm@x.y.z+sha512.<128 hex>.`];
  const canonical = canonicalPnpmRun(packageManager);
  const errors: string[] = [];
  const list = instructions(text.split(/\r?\n/));
  // Stage boundaries: index of each FROM.
  const stageStarts = list.flatMap((ins, i) => (ins.keyword === "FROM" ? [i] : []));
  const stageOf = (i: number) => stageStarts.filter((s) => s <= i).length - 1;
  const canonicalAt: number[] = [];
  list.forEach((ins, i) => {
    if (ins.keyword === "RUN" && !ins.heredoc && ins.text === canonical) {
      canonicalAt.push(i);
      return;
    }
    if (ins.heredoc && ins.keyword === "RUN" && /\bcorepack\b|\bpnpm\b/.test(ins.text))
      errors.push(
        `${dockerfile}:${ins.line}: heredoc RUN mentioning corepack/pnpm is not supported.`,
      );
    else if ((ins.keyword === "RUN" && /\bcorepack\b/.test(ins.text)) || /pnpm@/.test(ins.text))
      errors.push(
        `${dockerfile}:${ins.line}: only the canonical pnpm toolchain RUN may use corepack or a pnpm pin:\n    ${canonical}`,
      );
  });
  if (canonicalAt.length !== 1) {
    errors.push(
      `${dockerfile}: expected exactly one canonical pnpm toolchain RUN, found ${canonicalAt.length}:\n    ${canonical}`,
    );
    if (canonicalAt.length === 0) return errors;
  }
  const at = canonicalAt[0] as number;
  const stage = stageOf(at);
  if (dockerfile === "Dockerfile.dev" && stage !== stageStarts.length - 1)
    errors.push(
      `${dockerfile}: the pnpm toolchain RUN must be in the final stage, which the dev services run.`,
    );
  // Best-effort permission lint within that stage, resolving ENV and WORKDIR.
  const env = new Map<string, string>();
  let workdir = "/";
  const begin = stageStarts[stage] ?? 0;
  const end = stageStarts[stage + 1] ?? list.length;
  for (let i = begin; i < end; i++) {
    const ins = list[i] as Instruction;
    if (ins.keyword === "ENV")
      for (const m of ins.text.slice(3).matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S+)/g))
        env.set(
          m[1] as string,
          unquote(m[2] as string).replace(/\$\{?(\w+)\}?/g, (_, k) => env.get(k) ?? ""),
        );
    if (ins.keyword === "WORKDIR")
      workdir = normalize(`${workdir}/${unquote(ins.text.slice(7).trim())}`);
    const toolchain = [
      "/usr/local/lib/node_modules/corepack",
      ...["PNPM_HOME", "COREPACK_HOME"].flatMap((k) =>
        env.has(k) ? [normalize(env.get(k) as string)] : [],
      ),
    ];
    if ((ins.keyword === "COPY" || ins.keyword === "ADD") && /\s--ch(?:own|mod)=/.test(ins.text)) {
      // Best effort: the destination is the last argument (JSON form included).
      const dest = unquote(
        (
          ins.text
            .trim()
            .replace(/^\S+\s+/, "")
            .replace(/[[\],]/g, " ")
            .trim()
            .split(/\s+/)
            .pop() ?? ""
        ).replace(/^"|"$/g, ""),
      ).replace(/\$\{?(\w+)\}?/g, (_, k) => env.get(k) ?? `$${k}`);
      const target = dest.startsWith("/") ? normalize(dest) : normalize(`${workdir}/${dest}`);
      if (
        toolchain.some(
          (home) =>
            target === home ||
            target === "/" ||
            home.startsWith(`${target}/`) ||
            target.startsWith(`${home}/`),
        )
      )
        errors.push(
          `${dockerfile}:${ins.line}: ${ins.keyword} --chown/--chmod into the pnpm toolchain (${dest}).`,
        );
    }
    if (ins.keyword !== "RUN") continue;
    const allowed = MUTABLE_ALLOWLIST.map((p) =>
      normalize(p.replace(/\$(\w+)/g, (_, k) => env.get(k) ?? "")),
    );
    const tokens = ins.text.slice(3).split(/\s+/).filter(Boolean);
    for (let t = 0; t < tokens.length; t++) {
      const tool = (tokens[t] as string).split("/").pop() as string;
      if (!PERMISSION_TOOLS.has(tool)) continue;
      let modeSeen = tool !== "chmod";
      let ownerSeen = tool === "chmod";
      for (t++; t < tokens.length && !SEPARATORS.has(tokens[t] as string); t++) {
        const arg = tokens[t] as string;
        if (arg.startsWith("-")) continue;
        if (!modeSeen) {
          modeSeen = true;
          continue;
        }
        if (!ownerSeen) {
          ownerSeen = true;
          continue;
        }
        const raw = unquote(arg.replace(/[;&|]+$/, ""));
        if (!raw.startsWith("/") && !raw.startsWith("$")) {
          errors.push(
            `${dockerfile}:${ins.line}: ${tool} of a relative path (${raw}); use absolute paths.`,
          );
          continue;
        }
        const target = normalize(
          raw.startsWith("/")
            ? raw
            : raw.replace(/\$\{?(\w+)\}?/g, (_, k) => env.get(k) ?? `$${k}`),
        );
        if (allowed.includes(target)) continue;
        const hits = toolchain.some(
          (home) =>
            target === home ||
            home.startsWith(`${target}/`) ||
            target === "/" ||
            target.startsWith(`${home}/`),
        );
        if (hits)
          errors.push(
            `${dockerfile}:${ins.line}: ${tool} of ${raw} touches the pnpm toolchain or an ancestor; ` +
              `only ${MUTABLE_ALLOWLIST.join(", ")} may be made mutable.`,
          );
      }
    }
  }
  return errors;
}
