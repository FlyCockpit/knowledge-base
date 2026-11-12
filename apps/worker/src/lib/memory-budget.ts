/**
 * The memory the worker (and so its one forked Qwen child) may use:
 * the tightest cgroup v2 `memory.max` on the path from this process's cgroup to
 * the root, else the effective cgroup v1 hierarchy, else /proc/meminfo MemTotal. A
 * cgroup limit is capped at MemTotal. MemAvailable is reported for display only
 * (capped at the budget). An identified v1 hierarchy whose effective bound
 * cannot be established reports null, never the larger host budget.
 */
import { readFileSync } from "node:fs";

export type MemoryBudget = {
  budgetBytes: number;
  availableBytes: number;
  source: "cgroup-v2" | "cgroup-v1" | "meminfo";
};

type ReadFile = (path: string) => string | null;

/** v1 reports "unlimited" as a huge page-aligned value (e.g. 9223372036854771712). */
const UNLIMITED_BYTES = 2 ** 60;

function limit(text: string | null): number | null {
  const value = text?.trim();
  if (!value || !/^\d+$/.test(value)) return null; // "max", empty, garbage
  const bytes = Number(value);
  return bytes > 0 && bytes < UNLIMITED_BYTES ? bytes : null;
}

function meminfo(text: string | null) {
  const field = (name: string) => {
    const match = text && new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  return { total: field("MemTotal"), available: field("MemAvailable") };
}

function cgroupV2Limit(read: ReadFile, cgroups: string | null): number | null {
  if (read("/sys/fs/cgroup/cgroup.controllers") === null) return null;
  const path = /^0::(\/.*)$/m.exec(cgroups ?? "")?.[1];
  if (path === undefined) return null;
  let tightest: number | null = null;
  const parts = path.split("/").filter(Boolean);
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    const bytes = limit(read(`/sys/fs/cgroup${dir ? `/${dir}` : ""}/memory.max`));
    if (bytes !== null) tightest = tightest === null ? bytes : Math.min(tightest, bytes);
  }
  return tightest;
}

/** v1 namespaces can hide ancestors: memory.stat exposes the effective hierarchy. */
function cgroupV1Limit(read: ReadFile, cgroups: string | null): number | null | undefined {
  const path = /^\d+:(?:[^:]*,)?memory(?:,[^:]*)?:(\/.*)$/m.exec(cgroups ?? "")?.[1];
  if (path === undefined) return null;
  const mounts = (read("/proc/self/mountinfo") ?? "").split("\n");
  const controllers = mounts
    .map((line) => line.split(" "))
    .filter((fields) => {
      const separator = fields.indexOf("-");
      return (
        fields[separator + 1] === "cgroup" && fields[separator + 3]?.split(",").includes("memory")
      );
    });
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  for (const mount of controllers) {
    const root = decode(mount[3]!);
    const point = decode(mount[4]!);
    // A subtree mount uses host-relative paths; namespaces can report '/'.
    const relative =
      root !== "/" && (path === root || path.startsWith(`${root}/`))
        ? path.slice(root.length)
        : path;
    if (relative.split("/").some((part) => part === "." || part === "..")) continue;
    const parts = relative.split("/").filter(Boolean);
    const leaf = `${point}${parts.length ? `/${parts.join("/")}` : ""}`;
    // A namespace can virtualize /proc/self/cgroup while an inherited mount
    // exposes another root. cgroup.procs uses the reader's PID namespace, so
    // require this process before trusting any bound from the candidate mount.
    const members = read(`${leaf}/cgroup.procs`);
    if (!members?.split(/\s+/).includes(String(process.pid))) continue;
    const hierarchyText = /^hierarchical_memory_limit\s+(\d+)$/m.exec(
      read(`${leaf}/memory.stat`) ?? "",
    )?.[1];
    let tightest = limit(hierarchyText ?? null);
    // A valid hierarchical bound includes hidden ancestors. Without it, every
    // ancestor through a full-root mount must be readable.
    const hierarchical = hierarchyText !== undefined && Number(hierarchyText) > 0;
    if (root !== "/" && !hierarchical) continue;
    let unknown = false;
    for (let depth = parts.length; depth >= 0; depth--) {
      const dir = `${point}${depth ? `/${parts.slice(0, depth).join("/")}` : ""}`;
      const text = read(`${dir}/memory.limit_in_bytes`);
      if (!text || !/^\d+$/.test(text.trim()) || Number(text.trim()) <= 0) {
        if (!hierarchical) {
          unknown = true;
          break;
        }
        continue;
      }
      const bytes = limit(text);
      if (bytes !== null) tightest = tightest === null ? bytes : Math.min(tightest, bytes);
    }
    if (!unknown) return tightest;
  }
  // Identified v1 controller, but no mounted view establishes this process's bound.
  return undefined;
}

export function detectMemoryBudget(read: ReadFile = readText): MemoryBudget | null {
  const cgroups = read("/proc/self/cgroup");
  const mem = meminfo(read("/proc/meminfo"));
  // A cgroup may allow more than the machine physically has. Without this cap
  // even a known hierarchy cannot establish a safe worker budget.
  if (mem.total === null || !Number.isFinite(mem.total) || mem.total <= 0) return null;
  const v2 = cgroupV2Limit(read, cgroups);
  const v1 = v2 === null ? cgroupV1Limit(read, cgroups) : null;
  if (v1 === undefined) return null;
  const cgroup = v2 ?? v1;
  let budgetBytes: number;
  let source: MemoryBudget["source"];
  if (cgroup !== null && cgroup <= mem.total) {
    budgetBytes = cgroup;
    source = v2 !== null ? "cgroup-v2" : "cgroup-v1";
  } else if (mem.total !== null) {
    budgetBytes = mem.total;
    source = "meminfo";
  } else return null;
  const availableBytes = Math.min(mem.available ?? budgetBytes, budgetBytes);
  return { budgetBytes, availableBytes, source };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
