import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** Every ancestor is opened without following symlinks, and the inherited
 * flock descriptor must still name the native supervisor's actual role fence. */
export function assetRoleFenceProof(
  reposDir: string,
  role: "server" | "worker",
  variable = "KB_FENCE_FD",
): () => void {
  return () => {
    const fd = Number(process.env[variable]);
    if (!Number.isInteger(fd) || fd < 3 || !reposDir.startsWith("/"))
      throw new Error("Asset storage role fence unavailable");
    let parent = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const parts = `${reposDir}/.private/${role}.fence`.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (part === "." || part === "..") throw new Error("Asset storage role fence unavailable");
        const next = openSync(
          `/proc/self/fd/${parent}/${part}`,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            (i + 1 === parts.length ? 0 : constants.O_DIRECTORY),
        );
        closeSync(parent);
        parent = next;
      }
      const actual = fstatSync(fd),
        expected = fstatSync(parent);
      if (
        !actual.isFile() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        !/FLOCK.*WRITE/.test(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))
      )
        throw new Error("Asset storage role fence unavailable");
    } finally {
      closeSync(parent);
    }
  };
}
