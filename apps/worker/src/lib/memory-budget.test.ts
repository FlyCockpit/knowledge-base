import { assessQwenRuntimeConfig } from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { describe, expect, it } from "vitest";
import { detectMemoryBudget } from "./memory-budget";

const mount = "29 23 0:26 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n";
const unlimited = "9223372036854771712\n";

const GiB = 1024 ** 3;
const meminfo = (totalKiB: number, availableKiB: number) =>
  `MemTotal:       ${totalKiB} kB\nMemFree:         1000 kB\nMemAvailable:   ${availableKiB} kB\n`;

function files(map: Record<string, string>) {
  return (path: string) => (Object.hasOwn(map, path) ? map[path]! : null);
}

describe("worker memory budget", () => {
  it("cgroup v2: the tightest numeric memory.max from the process cgroup up to the root", () => {
    const budget = detectMemoryBudget(
      files({
        "/proc/self/cgroup": "0::/system.slice/kb-worker.service\n",
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids\n",
        "/sys/fs/cgroup/system.slice/kb-worker.service/memory.max": "max\n",
        "/sys/fs/cgroup/system.slice/memory.max": `${3 * GiB}\n`,
        "/proc/meminfo": meminfo(8 * 1024 * 1024, 5 * 1024 * 1024),
      }),
    );
    expect(budget).toEqual({
      budgetBytes: 3 * GiB,
      availableBytes: 3 * GiB,
      source: "cgroup-v2",
    });
  });

  it("cgroup v2 inside a container namespace (path '/'): the root memory.max", () => {
    const budget = detectMemoryBudget(
      files({
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/cgroup.controllers": "memory\n",
        "/sys/fs/cgroup/memory.max": `${2 * GiB}\n`,
        "/proc/meminfo": meminfo(8 * 1024 * 1024, 6 * 1024 * 1024),
      }),
    );
    expect(budget).toMatchObject({ budgetBytes: 2 * GiB, source: "cgroup-v2" });
    // Available is capped by the budget: memory the cgroup may never use is not "available".
    expect(budget?.availableBytes).toBe(2 * GiB);
  });

  it("cgroup v1: memory.limit_in_bytes of the memory controller path", () => {
    const budget = detectMemoryBudget(
      files({
        "/proc/self/cgroup":
          "12:pids:/docker/abc\n4:memory:/docker/abc\n1:name=systemd:/docker/abc\n",
        "/proc/self/mountinfo": mount,
        "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
        "/sys/fs/cgroup/memory/docker/memory.limit_in_bytes": unlimited,
        "/sys/fs/cgroup/memory/docker/abc/cgroup.procs": `${process.pid}\n`,
        "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": `${4 * GiB}\n`,
        "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
      }),
    );
    expect(budget).toMatchObject({ budgetBytes: 4 * GiB, source: "cgroup-v1" });
  });

  it("cgroup v1 in a container namespace falls back to the controller root", () => {
    const budget = detectMemoryBudget(
      files({
        "/proc/self/cgroup": "4:memory:/docker/abc\n",
        "/proc/self/mountinfo": mount.replace(" / /sys", " /docker/abc /sys"),
        "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
        "/sys/fs/cgroup/memory/memory.stat": `hierarchical_memory_limit ${3 * GiB}\n`,
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${3 * GiB}\n`,
        "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
      }),
    );
    expect(budget).toMatchObject({ budgetBytes: 3 * GiB, source: "cgroup-v1" });
  });

  it.each([`${8 * GiB}`, unlimited])(
    "v1 leaf %s respects a tighter intermediate ancestor",
    (leaf) => {
      expect(
        detectMemoryBudget(
          files({
            "/proc/self/cgroup": "4:cpu,memory:/parent/child\n",
            "/proc/self/mountinfo": mount,
            "/sys/fs/cgroup/memory/parent/child/cgroup.procs": `${process.pid}\n`,
            "/sys/fs/cgroup/memory/parent/child/memory.limit_in_bytes": leaf,
            "/sys/fs/cgroup/memory/parent/memory.limit_in_bytes": `${GiB}`,
            "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
            "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
            "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
          }),
        ),
      ).toMatchObject({ budgetBytes: GiB, source: "cgroup-v1" });
    },
  );

  it.each(["/", "/tenant"])("v1 namespace/subtree %s includes hidden parent limits", (path) => {
    expect(
      detectMemoryBudget(
        files({
          "/proc/self/cgroup": `4:memory:${path}\n`,
          "/proc/self/mountinfo": mount.replace(" / /sys", " /tenant /sys"),
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${8 * GiB}`,
          "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
          "/sys/fs/cgroup/memory/memory.stat": `hierarchical_memory_limit ${GiB}\n`,
          "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
        }),
      ),
    ).toMatchObject({ budgetBytes: GiB, source: "cgroup-v1" });
  });

  it("the actual runtime assessor blocks a 4K config above the effective parent budget", () => {
    const budget = detectMemoryBudget(
      files({
        "/proc/self/cgroup": "4:memory:/parent/child\n",
        "/proc/self/mountinfo": mount,
        "/sys/fs/cgroup/memory/parent/child/cgroup.procs": `${process.pid}\n`,
        "/sys/fs/cgroup/memory/parent/child/memory.limit_in_bytes": `${8 * GiB}`,
        "/sys/fs/cgroup/memory/parent/memory.limit_in_bytes": `${GiB}`,
        "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
        "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
      }),
    );
    expect(
      assessQwenRuntimeConfig(
        { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" },
        budget?.budgetBytes ?? null,
      ),
    ).toMatchObject({ level: "block" });
  });

  it("v1 tries all controller mounts so an unrelated view cannot hide a valid budget", () => {
    expect(
      detectMemoryBudget(
        files({
          "/proc/self/cgroup": "4:memory:/parent/child\n",
          "/proc/self/mountinfo":
            mount.replace(" / /sys/fs/cgroup/memory", " /other /sys/fs/cgroup/unrelated") + mount,
          "/sys/fs/cgroup/unrelated/parent/child/cgroup.procs": "0\n",
          "/sys/fs/cgroup/memory/parent/child/cgroup.procs": `${process.pid}\n`,
          "/sys/fs/cgroup/memory/parent/child/memory.limit_in_bytes": `${8 * GiB}`,
          "/sys/fs/cgroup/memory/parent/memory.limit_in_bytes": `${GiB}`,
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
          "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
        }),
      ),
    ).toMatchObject({ budgetBytes: GiB, source: "cgroup-v1" });
  });

  it("v1 fails closed when an inherited namespace mount exposes a different group's root", () => {
    expect(
      detectMemoryBudget(
        files({
          "/proc/self/cgroup": "4:memory:/\n",
          "/proc/self/mountinfo": mount,
          "/sys/fs/cgroup/memory/cgroup.procs": "0\n",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
          "/sys/fs/cgroup/memory/memory.stat": `hierarchical_memory_limit ${16 * GiB}\n`,
          "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
        }),
      ),
    ).toBeNull();
  });

  it("v1 fails closed on unknown mappings, missing ancestors or hidden hierarchy", () => {
    const base = {
      "/proc/self/cgroup": "4:memory:/child\n",
      "/proc/meminfo": meminfo(16 * 1024 * 1024, 10 * 1024 * 1024),
      "/sys/fs/cgroup/memory/child/memory.limit_in_bytes": `${8 * GiB}`,
    };
    expect(detectMemoryBudget(files(base))).toBeNull();
    expect(detectMemoryBudget(files({ ...base, "/proc/self/mountinfo": mount }))).toBeNull();
    expect(
      detectMemoryBudget(
        files({
          ...base,
          "/proc/self/mountinfo": mount.replace(" / /sys", " /tenant /sys"),
          "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
        }),
      ),
    ).toBeNull();
  });

  it("no cgroup limit (v2 'max', v1 unlimited sentinel, or no cgroupfs): /proc/meminfo MemTotal", () => {
    const host = meminfo(7_937_000, 4_700_000);
    const cases: Array<Record<string, string>> = [
      { "/proc/meminfo": host },
      {
        "/proc/self/cgroup": "0::/user.slice\n",
        "/sys/fs/cgroup/cgroup.controllers": "memory\n",
        "/sys/fs/cgroup/user.slice/memory.max": "max\n",
        "/proc/meminfo": host,
      },
      {
        "/proc/self/cgroup": "4:memory:/\n",
        "/proc/self/mountinfo": mount,
        "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": unlimited,
        "/proc/meminfo": host,
      },
    ];
    for (const fs of cases)
      expect(detectMemoryBudget(files(fs))).toEqual({
        budgetBytes: 7_937_000 * 1024,
        availableBytes: 4_700_000 * 1024,
        source: "meminfo",
      });
  });

  it("a cgroup limit above physical memory is capped at MemTotal", () => {
    const budget = detectMemoryBudget(
      files({
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/cgroup.controllers": "memory\n",
        "/sys/fs/cgroup/memory.max": `${64 * GiB}\n`,
        "/proc/meminfo": meminfo(8 * 1024 * 1024, 5 * 1024 * 1024),
      }),
    );
    expect(budget).toMatchObject({ budgetBytes: 8 * GiB, source: "meminfo" });
  });

  it("a finite cgroup cannot replace an unknown physical-memory cap", () => {
    expect(
      detectMemoryBudget(
        files({
          "/proc/self/cgroup": "0::/\n",
          "/sys/fs/cgroup/cgroup.controllers": "memory\n",
          "/sys/fs/cgroup/memory.max": `${2 * GiB}`,
        }),
      ),
    ).toBeNull();
    expect(
      detectMemoryBudget(
        files({
          "/proc/self/cgroup": "4:memory:/\n",
          "/proc/self/mountinfo": mount,
          "/sys/fs/cgroup/memory/cgroup.procs": `${process.pid}\n`,
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${2 * GiB}`,
        }),
      ),
    ).toBeNull();
  });

  it("unreadable /proc/meminfo and no cgroup limit reports nothing rather than a guess", () => {
    expect(detectMemoryBudget(files({}))).toBeNull();
    expect(detectMemoryBudget(files({ "/proc/meminfo": "garbage" }))).toBeNull();
  });
});
