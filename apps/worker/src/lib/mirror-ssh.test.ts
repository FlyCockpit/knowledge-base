import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { generateDeployKey } from "@knowledge-base/api/lib/kb/deploy-key";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMirrorStorage,
  drainMirrorGroup,
  encodeMirrorReply,
  fixedSshArgs,
  MIRROR_REPLY_FD,
  MirrorDrainError,
  parseMirrorReply,
  prepareMirrorScratch,
  processIdentity,
  recoverMirrorScratch,
} from "./mirror-ssh";

// All operations use the real filesystem; only selected observation/removal
// calls are fault-injected in the tests that explicitly exercise those errors.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function liveGroup() {
  const child = spawn(
    process.execPath,
    ["-e", "console.log('READY'); setInterval(() => {}, 1000)"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const closed = once(child, "close");
  await once(child.stdout!, "data");
  const pid = child.pid!;
  const identity = (await processIdentity(pid))!;
  const root = await mkdtemp("/dev/shm/mirror-drain-");
  dirs.push(root);
  const dir = join(root, "fault-attempt");
  await mkdir(dir, { mode: 0o700 });
  const marker = `${pid} ${identity}`;
  await writeFile(join(dir, "owner"), marker, { mode: 0o600 });
  await writeFile(join(dir, "group"), marker, { mode: 0o600 });
  await writeFile(join(dir, "key"), "disposable fixture", { mode: 0o600 });
  return {
    root,
    dir,
    pid,
    identity,
    marker,
    async close() {
      vi.restoreAllMocks();
      child.kill("SIGKILL");
      await closed;
    },
  };
}

describe("mirror drain evidence with real processes and filesystem", () => {
  it("preserves both unreadable ownership markers while the original group is still alive", async () => {
    const f = await liveGroup();
    try {
      await chmod(join(f.dir, "owner"), 0);
      await chmod(join(f.dir, "group"), 0);
      await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(MirrorDrainError);
      expect(await processIdentity(f.pid)).toBe(f.identity);
      expect(await readFile(join(f.dir, "key"), "utf8")).toBe("disposable fixture");
      await chmod(join(f.dir, "owner"), 0o600);
      await chmod(join(f.dir, "group"), 0o600);
      await recoverMirrorScratch("fault", f.root);
      expect(await processIdentity(f.pid)).toBeNull();
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each(["owner", "group"])(
    "preserves unreadable %s evidence and permits drain after repair",
    async (name) => {
      expect(process.getuid?.()).not.toBe(0); // chmod must exercise an actual EACCES.
      const f = await liveGroup();
      try {
        if (name === "group") await writeFile(join(f.dir, "owner"), "2147483647 1");
        await chmod(join(f.dir, name), 0);
        await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        expect(await processIdentity(f.pid)).toBe(f.identity);
        expect(await readdir(f.dir)).toEqual(expect.arrayContaining(["owner", "group", "key"]));
        await chmod(join(f.dir, name), 0o600);
        await recoverMirrorScratch("fault", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
        expect(await readdir(f.root)).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["", "garbage", "0 123", "2 null", "2 123\n", "2 123 extra", "2 0123"])(
    "preserves invalid existing ownership evidence %j",
    async (marker) => {
      const f = await liveGroup();
      try {
        await writeFile(join(f.dir, "owner"), marker);
        await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        expect(await processIdentity(f.pid)).toBe(f.identity);
        expect(await readFile(join(f.dir, "owner"), "utf8")).toBe(marker);
        await writeFile(join(f.dir, "owner"), f.marker);
        await recoverMirrorScratch("fault", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
      } finally {
        await f.close();
      }
    },
  );

  it.each(["owner", "group"])(
    "preserves missing %s evidence rather than treating it as preparation",
    async (name) => {
      const f = await liveGroup();
      try {
        if (name === "group") await writeFile(join(f.dir, "owner"), "2147483647 1");
        await rm(join(f.dir, name));
        await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        expect(await processIdentity(f.pid)).toBe(f.identity);
        expect(await readFile(join(f.dir, "key"), "utf8")).toBe("disposable fixture");
        await writeFile(join(f.dir, name), f.marker);
        await recoverMirrorScratch("fault", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
      } finally {
        await f.close();
      }
    },
  );

  it.each(["EACCES", "EIO", "malformed"])(
    "preserves non-authoritative process observation (%s)",
    async (fault) => {
      const f = await liveGroup();
      try {
        const actualRead = fs.readFile;
        const spy = vi.spyOn(fs, "readFile").mockImplementation((...args) => {
          if (args[0] === `/proc/${f.pid}/stat`)
            return fault === "malformed"
              ? Promise.resolve("invalid stat")
              : Promise.reject(
                  Object.assign(new Error("fixture observation fault"), { code: fault }),
                );
          return actualRead(...args);
        });
        await expect(processIdentity(f.pid)).rejects.toBeInstanceOf(MirrorDrainError);
        expect(spy.mock.calls.filter(([path]) => path === `/proc/${f.pid}/stat`)).toHaveLength(
          fault === "malformed" ? 3 : 1,
        );
        await expect(drainMirrorGroup(f.pid)).rejects.toBeInstanceOf(MirrorDrainError);
        await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        spy.mockRestore();
        expect(await processIdentity(f.pid)).toBe(f.identity);
        expect(await readFile(join(f.dir, "owner"), "utf8")).toBe(f.marker);
        await recoverMirrorScratch("fault", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
      } finally {
        await f.close();
      }
    },
  );

  it("accepts positively known preparation and empty creation without inventing a process", async () => {
    const root = await mkdtemp("/dev/shm/mirror-drain-");
    dirs.push(root);
    await mkdir(join(root, "fault-empty"), { mode: 0o700 });
    const prepared = join(root, "fault-prepared");
    await mkdir(prepared, { mode: 0o700 });
    await writeFile(join(prepared, "owner"), "PREPARED");
    await writeFile(join(prepared, "group"), "NOT_STARTED");
    await writeFile(join(prepared, "key"), "disposable fixture");
    await recoverMirrorScratch("fault", root);
    expect(await readdir(root)).toEqual([]);
    await recoverMirrorScratch("fault", root); // empty/re-entry is a positive absence proof
  });

  it("retains a preparation drain proof across cleanup failure and permits retry", async () => {
    const root = await mkdtemp("/dev/shm/mirror-drain-");
    dirs.push(root);
    const seed = generateDeployKey();
    try {
      const actualRemove = fs.rm;
      const spy = vi
        .spyOn(fs, "rm")
        .mockImplementation((...args) =>
          String(args[0]).endsWith(".drained")
            ? Promise.reject(
                Object.assign(new Error("fixture preparation cleanup fault"), { code: "EIO" }),
              )
            : actualRemove(...args),
        );
      await expect(
        prepareMirrorScratch(
          root,
          "/canonical/kb.git",
          seed.seed,
          ["invalid"],
          "git.example.com",
          "fault",
        ),
      ).rejects.toBeInstanceOf(MirrorDrainError);
      const names = await readdir(root);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/\.drained$/);
      spy.mockRestore();
      await recoverMirrorScratch("fault", root);
      expect(await readdir(root)).toEqual([]);
    } finally {
      seed.seed.destroy();
    }
  });

  it("does not signal a reused helper PID and rejects a reused group identity", async () => {
    const f = await liveGroup();
    try {
      await writeFile(join(f.dir, "owner"), `${f.pid} ${BigInt(f.identity) + 1n}`);
      await writeFile(join(f.dir, "group"), `${f.pid} ${BigInt(f.identity) + 1n}`);
      await expect(recoverMirrorScratch("fault", f.root)).rejects.toThrow("identity changed");
      expect(await processIdentity(f.pid)).toBe(f.identity);
      await writeFile(join(f.dir, "group"), f.marker);
      await recoverMirrorScratch("fault", f.root);
      expect(await processIdentity(f.pid)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("wraps ordinary root and removal errors as unconfirmed drain", async () => {
    const f = await liveGroup();
    try {
      await chmod(f.root, 0);
      await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(MirrorDrainError);
      await chmod(f.root, 0o700);
      const actualRemove = fs.rm;
      const spy = vi.spyOn(fs, "rm").mockImplementation((...args) =>
        args[0] === `${f.dir}.drained`
          ? actualRemove(join(`${f.dir}.drained`, "owner")).then(() => {
              throw Object.assign(new Error("fixture partial remove fault"), { code: "EIO" });
            })
          : actualRemove(...args),
      );
      await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(MirrorDrainError);
      expect(await readFile(join(`${f.dir}.drained`, "group"), "utf8")).toBe(f.marker);
      expect(await processIdentity(f.pid)).toBeNull();
      spy.mockRestore();
      await recoverMirrorScratch("fault", f.root);
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      await chmod(f.root, 0o700);
      await f.close();
    }
  });
});
describe("bounded mirror process re-observation", () => {
  function invalidStat(raw: string, fault: string) {
    if (fault === "empty") return "";
    if (fault === "pid") return raw.replace(/^\d+/, "0");
    const end = raw.lastIndexOf(") ") + 2;
    const fields = raw.slice(end).trim().split(" ");
    if (fault === "exit") {
      fields[0] = "X";
      fields[2] = "-1";
    } else if (fault === "state") fields[0] = "invalid";
    else fields[19] = "invalid";
    return raw.slice(0, end) + fields.join(" ");
  }

  it.each(["exit", "empty", "pid", "state", "identity"])(
    "re-observes transient invalid %s data before returning a validated identity",
    async (fault) => {
      const f = await liveGroup();
      try {
        const native = fs.readFile;
        const path = `/proc/${f.pid}/stat`;
        const raw = await native(path, "utf8");
        let reads = 0;
        vi.spyOn(fs, "readFile").mockImplementation((...args) => {
          if (args[0] === path && ++reads === 1) return Promise.resolve(invalidStat(raw, fault));
          return native(...args);
        });
        expect(await processIdentity(f.pid)).toBe(f.identity);
        expect(reads).toBe(2);
      } finally {
        await f.close();
      }
    },
  );

  it("accepts a validated third observation after two invalid records", async () => {
    const f = await liveGroup();
    try {
      const native = fs.readFile;
      let reads = 0;
      vi.spyOn(fs, "readFile").mockImplementation((...args) => {
        if (args[0] === `/proc/${f.pid}/stat` && ++reads <= 2) return Promise.resolve("");
        return native(...args);
      });
      expect(await processIdentity(f.pid)).toBe(f.identity);
      expect(reads).toBe(3);
    } finally {
      await f.close();
    }
  });

  it.each(["ENOENT", "ESRCH"])(
    "accepts authoritative %s only after re-observing invalid data",
    async (code) => {
      const f = await liveGroup();
      try {
        const native = fs.readFile;
        let reads = 0;
        vi.spyOn(fs, "readFile").mockImplementation((...args) => {
          if (args[0] === `/proc/${f.pid}/stat`)
            return ++reads === 1
              ? Promise.resolve("")
              : Promise.reject(Object.assign(new Error("fixture disappearance"), { code }));
          return native(...args);
        });
        expect(await processIdentity(f.pid)).toBeNull();
        expect(reads).toBe(2);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["exit", "empty", "pid"])(
    "bounds persistent invalid %s data without signalling or removing evidence",
    async (fault) => {
      const f = await liveGroup();
      try {
        const native = fs.readFile;
        const path = `/proc/${f.pid}/stat`;
        const raw = await native(path, "utf8");
        let reads = 0;
        vi.spyOn(fs, "readFile").mockImplementation((...args) => {
          if (args[0] === path) {
            reads++;
            return Promise.resolve(invalidStat(raw, fault));
          }
          return native(...args);
        });
        const kill = vi.spyOn(process, "kill");
        await expect(recoverMirrorScratch("fault", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        expect(reads).toBe(3);
        expect(kill).not.toHaveBeenCalled();
        expect(await readFile(join(f.dir, "owner"), "utf8")).toBe(f.marker);
        expect(await readFile(join(f.dir, "group"), "utf8")).toBe(f.marker);
        expect(await readFile(join(f.dir, "key"), "utf8")).toBe("disposable fixture");
        vi.restoreAllMocks();
        expect(await processIdentity(f.pid)).toBe(f.identity);
        await recoverMirrorScratch("fault", f.root);
        expect(await readdir(f.root)).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it("rejects a validated successor after a transient read without signalling it", async () => {
    const f = await liveGroup();
    try {
      await writeFile(join(f.dir, "owner"), "2147483647 1");
      const native = fs.readFile;
      const path = `/proc/${f.pid}/stat`;
      const raw = await native(path, "utf8");
      const end = raw.lastIndexOf(") ") + 2;
      const fields = raw.slice(end).trim().split(" ");
      fields[19] = String(BigInt(f.identity) + 1n);
      const successor = raw.slice(0, end) + fields.join(" ");
      let reads = 0;
      vi.spyOn(fs, "readFile").mockImplementation((...args) =>
        args[0] === path ? Promise.resolve(++reads === 1 ? "" : successor) : native(...args),
      );
      const kill = vi.spyOn(process, "kill");
      await expect(recoverMirrorScratch("fault", f.root)).rejects.toThrow("identity changed");
      expect(reads).toBe(2);
      expect(kill).not.toHaveBeenCalled();
      expect(await readFile(join(f.dir, "group"), "utf8")).toBe(f.marker);
      vi.restoreAllMocks();
      expect(await processIdentity(f.pid)).toBe(f.identity);
      await recoverMirrorScratch("fault", f.root);
    } finally {
      await f.close();
    }
  });

  it("joins an actual terminated helper after transient teardown data and permits re-entry", async () => {
    const f = await liveGroup();
    try {
      const nativeRead = fs.readFile;
      const path = `/proc/${f.pid}/stat`;
      const raw = await nativeRead(path, "utf8");
      const nativeKill = process.kill;
      let terminated = false,
        injected = false,
        reobserved = false;
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        const result = nativeKill(pid, signal);
        if (pid === f.pid && signal === "SIGTERM") terminated = true;
        return result;
      });
      vi.spyOn(fs, "readFile").mockImplementation((...args) => {
        if (args[0] === path && terminated) {
          if (!injected) {
            injected = true;
            return Promise.resolve(invalidStat(raw, "exit"));
          }
          reobserved = true;
        }
        return nativeRead(...args);
      });
      await recoverMirrorScratch("fault", f.root);
      expect(terminated && injected && reobserved).toBe(true);
      expect(await processIdentity(f.pid)).toBeNull();
      expect(await readdir(f.root)).toEqual([]);
      await recoverMirrorScratch("fault", f.root);
    } finally {
      await f.close();
    }
  });

  it("drains an actual group despite an unrelated transient process observation", async () => {
    const f = await liveGroup();
    try {
      const native = fs.readFile;
      const path = `/proc/${process.pid}/stat`;
      const raw = await native(path, "utf8");
      let reads = 0;
      vi.spyOn(fs, "readFile").mockImplementation((...args) => {
        if (args[0] === path && ++reads === 1) return Promise.resolve(invalidStat(raw, "exit"));
        return native(...args);
      });
      await drainMirrorGroup(f.pid);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(await processIdentity(f.pid)).toBeNull();
      vi.restoreAllMocks();
      await recoverMirrorScratch("fault", f.root);
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

describe("mirror transport boundaries", () => {
  async function liveAttempt() {
    const root = await mkdtemp("/dev/shm/mirror-drain-");
    dirs.push(root);
    const dir = join(root, "attempt-live");
    await mkdir(dir, { mode: 0o700 });
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const done = once(child, "close");
    await once(child.stdout, "data");
    const pid = child.pid!;
    const marker = `${pid} ${await processIdentity(pid)}`;
    // A distinct process group owns execution; no observer/kill substitute.
    await writeFile(join(dir, "group"), marker, { mode: 0o600 });
    await writeFile(join(dir, "owner"), marker, { mode: 0o600 });
    return {
      root,
      dir,
      pid,
      marker,
      async close() {
        vi.restoreAllMocks();
        await chmod(dir, 0o700).catch(() => {});
        await chmod(join(dir, "owner"), 0o600).catch(() => {});
        await chmod(join(dir, "group"), 0o600).catch(() => {});
        if (await processIdentity(pid)) process.kill(-pid, "SIGKILL");
        await done;
      },
    };
  }
  it.each(["owner", "group"])(
    "retains a live group and unreadable %s evidence until observation is restored",
    async (name) => {
      const f = await liveAttempt();
      try {
        await chmod(join(f.dir, name), 0);
        await expect(recoverMirrorScratch("attempt", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        expect(await processIdentity(f.pid)).not.toBeNull();
        expect(await readdir(f.root)).toEqual(["attempt-live"]);
        await chmod(join(f.dir, name), 0o600);
        await recoverMirrorScratch("attempt", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
        expect(await readdir(f.root)).toEqual([]);
        await recoverMirrorScratch("attempt", f.root); // harmless re-entry
      } finally {
        await f.close();
      }
    },
  );
  it.each(["", "garbage", "2 null", "1 123", "2 123\nextra"])(
    "fails closed on malformed ownership %j without erasing it",
    async (marker) => {
      const f = await liveAttempt();
      try {
        await writeFile(join(f.dir, "group"), marker);
        await expect(recoverMirrorScratch("attempt", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        expect(await processIdentity(f.pid)).not.toBeNull();
        expect(await readFile(join(f.dir, "group"), "utf8")).toBe(marker);
        await writeFile(join(f.dir, "group"), f.marker);
        await recoverMirrorScratch("attempt", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
      } finally {
        await f.close();
      }
    },
  );
  it("does not kill a recycled group generation", async () => {
    const f = await liveAttempt();
    try {
      // Owner evidence names an already-exited helper; only the group remains.
      await writeFile(join(f.dir, "owner"), "2147483647 1");
      await writeFile(join(f.dir, "group"), `${f.pid} 0`);
      await expect(recoverMirrorScratch("attempt", f.root)).rejects.toBeInstanceOf(
        MirrorDrainError,
      );
      expect(await processIdentity(f.pid)).not.toBeNull();
      await writeFile(join(f.dir, "group"), f.marker);
      await recoverMirrorScratch("attempt", f.root);
    } finally {
      await f.close();
    }
  });
  it.each(["unreadable", "malformed"])(
    "propagates %s proc evidence during real group enumeration",
    async (fault) => {
      const f = await liveAttempt();
      const native = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
        .readFile;
      try {
        vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
          if (args[0] === `/proc/${f.pid}/stat`)
            return fault === "unreadable"
              ? Promise.reject(Object.assign(new Error("fault"), { code: "EACCES" }))
              : Promise.resolve("malformed proc stat");
          return Reflect.apply(native, fs, args);
        });
        await expect(drainMirrorGroup(f.pid)).rejects.toBeInstanceOf(MirrorDrainError);
        await expect(recoverMirrorScratch("attempt", f.root)).rejects.toBeInstanceOf(
          MirrorDrainError,
        );
        vi.restoreAllMocks();
        expect(await processIdentity(f.pid)).not.toBeNull();
        await recoverMirrorScratch("attempt", f.root);
        expect(await processIdentity(f.pid)).toBeNull();
      } finally {
        vi.restoreAllMocks();
        await f.close();
      }
    },
  );
  it("does not acknowledge a failed termination of a live owner", async () => {
    const f = await liveAttempt();
    const native = process.kill;
    try {
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === f.pid && signal === "SIGTERM")
          throw Object.assign(new Error("fault"), { code: "EPERM" });
        return native(pid, signal);
      });
      await expect(recoverMirrorScratch("attempt", f.root)).rejects.toBeInstanceOf(
        MirrorDrainError,
      );
      expect(await processIdentity(f.pid)).not.toBeNull();
      expect(await readdir(f.root)).toEqual(["attempt-live"]);
      vi.restoreAllMocks();
      await recoverMirrorScratch("attempt", f.root);
      expect(await processIdentity(f.pid)).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("accepts a valid lowercase proc state without treating the process as absent", async () => {
    const f = await liveAttempt();
    const native = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
      .readFile;
    try {
      const path = `/proc/${f.pid}/stat`;
      const text = await native(path, "utf8");
      const state = text.lastIndexOf(") ") + 2;
      const traced = text.slice(0, state) + "t" + text.slice(state + 1);
      vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) =>
        args[0] === path ? Promise.resolve(traced) : Reflect.apply(native, fs, args),
      );
      expect(await processIdentity(f.pid)).toBe(f.marker.split(" ")[1]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });
  it("propagates cleanup failure after joining, then permits successful re-entry", async () => {
    const f = await liveAttempt();
    try {
      await chmod(f.dir, 0o500);
      await expect(recoverMirrorScratch("attempt", f.root)).rejects.toBeInstanceOf(
        MirrorDrainError,
      );
      expect(await processIdentity(f.pid)).toBeNull();
      // The positively drained scratch keeps its drain proof in its name.
      expect(await readdir(f.root)).toEqual(["attempt-live.drained"]);
      await chmod(`${f.dir}.drained`, 0o700);
      await recoverMirrorScratch("attempt", f.root);
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("fixes SSH authentication, host pin and transport options without forwarding caller argv", () => {
    const argv = fixedSshArgs({
      address: "93.184.216.4",
      port: 2222,
      host: "git.example.com",
      key: "/run/kb-mirror/a/key",
      knownHosts: "/run/kb-mirror/a/hosts",
      command: "git-receive-pack '/o/r.git'",
    });
    for (const flag of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "ForwardAgent=no",
      "ProxyCommand=none",
      "ProxyJump=none",
      "HostKeyAlias=git.example.com",
      "Hostname=93.184.216.4",
    ])
      expect(argv).toContain(flag);
    expect(argv.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    expect(argv).toContain("GlobalKnownHostsFile=/dev/null");
    expect(argv).toContain("UserKnownHostsFile=/run/kb-mirror/a/hosts");
    expect(argv.at(-1)).toBe("git-receive-pack '/o/r.git'");
  });
  it("fails closed on durable-disk or shared key storage and admits a private tmpfs", async () => {
    // /var/tmp is disk-backed (the host tmpdir may itself be tmpfs).
    const disk = await mkdtemp("/var/tmp/mirror-disk-");
    dirs.push(disk);
    expect((await statfs(disk)).type).not.toBe(0x01021994);
    await expect(assertMirrorStorage(disk)).rejects.toThrow(/private UID-owned tmpfs/);
    const shared = await mkdtemp("/dev/shm/mirror-unit-");
    dirs.push(shared);
    await chmod(shared, 0o755);
    await expect(assertMirrorStorage(shared)).rejects.toThrow(/private UID-owned tmpfs/);
    const ram = await mkdtemp("/dev/shm/mirror-unit-");
    dirs.push(ram);
    await expect(assertMirrorStorage(ram)).resolves.toBeUndefined();
  });
  it("writes a 0600 key and a scratch-only alternate, then removes the entire private attempt", async () => {
    const root = await mkdtemp("/dev/shm/mirror-unit-");
    dirs.push(root);
    const seed = generateDeployKey();
    try {
      const scratch = await prepareMirrorScratch(
        root,
        "/canonical/kb.git",
        seed.seed,
        [seed.publicKey],
        "git.example.com",
      );
      expect((await stat(scratch.key)).mode & 0o777).toBe(0o600);
      expect((await stat(scratch.dir)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(scratch.repo, "objects/info/alternates"), "utf8")).toBe(
        "/canonical/kb.git/objects\n",
      );
      await scratch.close();
      expect(await readdir(root)).toEqual([]);
    } finally {
      seed.seed.destroy();
    }
  });
});

describe("mirror helper reply channel", () => {
  it("accepts only one closed-set reply frame", () => {
    const frame = (text: string) => Buffer.from(text, "latin1");
    expect(
      parseMirrorReply(frame(encodeMirrorReply({ state: "COMPLETED", resultCode: "PUSHED" }))),
    ).toEqual({
      state: "COMPLETED",
      resultCode: "PUSHED",
    });
    for (const text of [
      "",
      "COMPLETED PUSHED",
      "COMPLETED PUSH_REJECTED\n",
      "FAILED PUSHED\n",
      "CANCELLED SETTLED\n",
      "COMPLETED PUSHED\nCOMPLETED PUSHED\n",
      '{"state":"COMPLETED","resultCode":"PUSHED"}\n',
      `COMPLETED ${"P".repeat(300)}\n`,
    ])
      expect(parseMirrorReply(frame(text))).toBeUndefined();
  });

  it("replies on its dedicated descriptor and writes nothing to stdout or stderr", async () => {
    const dir = await mkdtemp("/dev/shm/mirror-reply-");
    dirs.push(dir);
    const config = join(dir, "config.json");
    // An invalid sha fails before any group spawn; the helper must still reply.
    await writeFile(config, JSON.stringify({ dir, repo: dir, sha: "x", timeoutMs: 5000 }));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", new URL("../ssh-wrapper.ts", import.meta.url).pathname, "--run", config],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
    const collect = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      return () => Buffer.concat(chunks);
    };
    const stdout = collect(child.stdout!);
    const stderr = collect(child.stderr!);
    const reply = collect(child.stdio[MIRROR_REPLY_FD] as NodeJS.ReadableStream);
    const closed = once(child, "close");
    child.stdin!.write("GO");
    const [code] = await closed;
    expect(code).toBe(0);
    expect(parseMirrorReply(reply())).toEqual({
      state: "FAILED",
      resultCode: "TRANSPORT_UNAVAILABLE",
    });
    expect(stdout().length).toBe(0);
    expect(stderr().toString()).toBe("");
  }, 30_000);
});
