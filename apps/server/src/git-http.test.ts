import type { TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import {
  PUSH_REFUSALS,
  type PushRefusalCode,
  PushRefusedError,
} from "@knowledge-base/api/lib/kb/push-validation";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { captureLog } from "@knowledge-base/env/log";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bodyPolicyMiddleware } from "./body-policy";
import { createGitHttp } from "./git-http";
import { closeAdmission, resetAdmissionForTests } from "./kb-process";
import { bindBearerAdmission } from "./mcp/context";

const { backend, receivePush } = vi.hoisted(() => ({ backend: vi.fn(), receivePush: vi.fn() }));
vi.mock("./git-cgi", async (original) => ({ ...(await original<object>()), runGitCgi: backend }));
vi.mock("./push-context", async (original) => ({ ...(await original<object>()), receivePush }));
vi.mock("@knowledge-base/api/lib/kb/authority-lock", async (original) => ({
  ...(await original<object>()),
  runLockedOperation: vi.fn(async () => undefined),
}));
const id = "a123456789012345678901234";
const pat = `kbp_${"a".repeat(16)}_${"b".repeat(43)}`;
const basic = (password = pat) => `Basic ${Buffer.from(`ignored:${password}`).toString("base64")}`;
const storedAcl = new Map<string, readonly string[]>([[id, ["read"]]]);
const principal: TokenPrincipal = {
  kind: "token",
  userId: "user",
  grantId: "grant",
  grantGeneration: "grant",
  scopes: ["mcp:read"],
  expiresAt: new Date(Date.now() + 3600000),
  storedAcl,
  credential: { kind: "PAT", clientId: "pat", tokenId: "token", resource: "http://localhost/mcp" },
};
function fixture(options: { push?: boolean } = {}) {
  const verifier = {
    inspect: vi.fn(async () => ({
      generationActive: true,
      instanceEnabled: true,
      expired: false,
      banned: false,
      twoFactorSatisfied: true,
      toolGroups: ["read", "edit"],
    })),
  };
  const store = {
    loadKb: vi.fn(async () => ({ id, ownerId: "user", state: "ACTIVE" as const })),
    loadShare: vi.fn(async () => null),
    loadIdentity: vi.fn(async () => ({
      banned: false,
      twoFactorSatisfied: true,
      instanceEnabled: true,
    })),
  };
  const admit = vi.fn(async (request: Request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${pat}`);
    expect(request.headers.has("cookie")).toBe(false);
    return bindBearerAdmission(principal, verifier);
  });
  const git = createGitHttp({
    reposDir: "/tmp",
    store,
    admit,
    retainedRefs: async () => ["refs/heads/main"],
    ...(options.push
      ? {
          push: {
            connectionString: "postgres://unused",
            canonicalOrigin: "http://localhost",
            ratePort: {} as never,
          },
        }
      : {}),
  });
  const app = new Hono();
  app.use("*", bodyPolicyMiddleware());
  app.route("/", git.app);
  return { app, git, store, verifier, admit };
}
beforeEach(() => {
  setKbRecoveryComplete(true);
  resetAdmissionForTests();
  backend.mockReset();
  backend.mockImplementation(async ({ onDone }: { onDone(): Promise<void> }) => {
    await onDone();
    return new Response("git");
  });
});
describe("Git HTTP permission refusals", () => {
  const pkt = (line: string) =>
    `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;
  const pushBody = (capabilities: string) =>
    `${pkt(`${"1".repeat(40)} ${"2".repeat(40)} refs/heads/main\0${capabilities}\n`)}0000`;
  const post = (app: Hono, body: string) =>
    app.request(`/git/${id}.git/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/x-git-receive-pack-request",
      },
      body,
    });
  it("explains a missing tool group in a plain-text body Git prints as remote:", async () => {
    const { app, verifier } = fixture();
    verifier.inspect.mockResolvedValue({
      generationActive: true,
      instanceEnabled: true,
      expired: false,
      banned: false,
      twoFactorSatisfied: true,
      toolGroups: ["read"],
    });
    const response = await app.request(`/git/${id}.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic() },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toMatch(/does not include the edit tool group/);
  });
  it("explains missing propose access on receive-pack discovery", async () => {
    const { app } = fixture({ push: true });
    const response = await app.request(`/git/${id}.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic() },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/requires Propose access/);
  });
  it("rejects a main push without write as a report-status ng over side-band", async () => {
    const { app } = fixture({ push: true });
    storedAcl.set(id, ["read", "propose"]);
    principal.scopes = ["mcp:read", "mcp:write"];
    receivePush.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" as const }),
    );
    try {
      const response = await post(
        app,
        pushBody(" report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.53.0"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = bytes.toString("utf8");
      // Band 2 (progress → `remote:`), then band 1 carrying the report-status.
      expect(bytes[4]).toBe(2);
      expect(text).toContain("Pushing to main requires Write access");
      expect(text).toContain("unpack ok\n");
      expect(text).toMatch(/ng refs\/heads\/main Pushing to main requires Write access/);
      expect(text.endsWith("0000")).toBe(true);
    } finally {
      principal.scopes = ["mcp:read"];
      storedAcl.set(id, ["read"]);
    }
  });
  it("uses plain report-status without side-band, and 403 without report-status", async () => {
    const { app } = fixture({ push: true });
    storedAcl.set(id, ["read", "propose"]);
    principal.scopes = ["mcp:read", "mcp:write"];
    receivePush.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" as const }),
    );
    try {
      const plain = await post(app, pushBody("report-status"));
      expect(plain.status).toBe(200);
      expect(await plain.text()).toBe(
        `${pkt("unpack ok\n")}${pkt("ng refs/heads/main Pushing to main requires Write access. Push a branch instead and open a pull request.\n")}0000`,
      );
      const bare = await post(app, pushBody("agent=git/2"));
      expect(bare.status).toBe(403);
      expect(await bare.text()).toMatch(/Pushing to main requires Write access/);
    } finally {
      receivePush.mockReset();
      principal.scopes = ["mcp:read"];
      storedAcl.set(id, ["read"]);
    }
  });
});
describe("Git HTTP push refusals and failures (R3-W10, R3-W3)", () => {
  const pkt = (line: string) =>
    `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;
  const branchBody = (capabilities: string) =>
    `${pkt(`${"0".repeat(40)} ${"2".repeat(40)} refs/heads/topic\0${capabilities}\n`)}0000`;
  const post = (app: Hono, body: string) =>
    app.request(`/git/${id}.git/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/x-git-receive-pack-request",
      },
      body,
    });
  it.each([
    { refs: ["refs/heads/topic", "refs/heads/second"], refusal: "MULTIPLE_REFS", deleting: false },
    { refs: ["refs/tags/v1"], refusal: "INVALID_NAMESPACE", deleting: false },
    { refs: ["refs/tags/v1+build"], refusal: "INVALID_NAMESPACE", deleting: false },
    { refs: ["refs/tags/版本+1"], refusal: "INVALID_NAMESPACE", deleting: false },
    { refs: ["refs/tags/a b"], refusal: "INVALID_NAMESPACE", deleting: false },
    { refs: ["refs/heads/other+name"], refusal: "INVALID_REF", deleting: false },
    { refs: ["refs/heads/café"], refusal: "INVALID_REF", deleting: false },
    {
      refs: ["refs/heads/topic", "refs/tags/v1+build", "refs/heads/分支+1"],
      refusal: "MULTIPLE_REFS",
      deleting: false,
    },
    { refs: ["refs/heads/topic"], refusal: "DELETE_REF", deleting: true },
    { refs: ["refs/heads/pr/9"], refusal: "RESERVED_REF", deleting: false },
  ] as const)(
    "reports early $refusal for every ref and logs a refusal",
    async ({ refs, refusal, deleting }) => {
      const { app } = fixture({ push: true });
      storedAcl.set(id, ["read", "propose"]);
      principal.scopes = ["mcp:read", "mcp:write"];
      const logged = captureLog();
      try {
        const body =
          refs
            .map((ref, index) =>
              pkt(
                `${"1".repeat(40)} ${deleting ? "0".repeat(40) : "2".repeat(40)} ${ref}${index === 0 ? "\0report-status side-band-64k" : ""}\n`,
              ),
            )
            .join("") + "0000";
        const response = await post(app, body);
        expect(response.status).toBe(200);
        const text = await response.text();
        for (const ref of refs) expect(text).toContain(`ng ${ref} ${PUSH_REFUSALS[refusal]}`);
        expect(logged.records).toContainEqual(
          expect.objectContaining({ site: "git-http.refused", level: "info", reason: refusal }),
        );
        expect(logged.records).not.toContainEqual(expect.objectContaining({ level: "error" }));
      } finally {
        logged.restore();
        principal.scopes = ["mcp:read"];
        storedAcl.set(id, ["read"]);
      }
    },
  );
  it.each(["x", "😀"])("frames 128 maximal %s identities without losing bytes", async (char) => {
    const { app } = fixture({ push: true });
    storedAcl.set(id, ["read", "propose"]);
    principal.scopes = ["mcp:read", "mcp:write"];
    try {
      const refs = Array.from(
        { length: 128 },
        (_, index) =>
          `refs/tags/${`${char.repeat(50)}/`.repeat(19)}${char.repeat(47)}${String(index).padStart(3, "0")}`,
      );
      // The wire identity limit is 1,024 scalars after "refs/".
      for (const ref of refs) expect([...ref.slice(5)]).toHaveLength(1024);
      const body =
        refs
          .map((ref, index) =>
            pkt(
              `${"1".repeat(40)} ${"2".repeat(40)} ${ref}${index === 0 ? "\0report-status-v2 side-band-64k" : ""}\n`,
            ),
          )
          .join("") + "0000";
      const response = await post(app, body);
      expect(response.status).toBe(200);
      // Decode both framing layers. Concatenate bytes before decoding UTF-8:
      // a frame can end in the middle of a multibyte ref or an inner pkt-line.
      function decode(bytes: Buffer): Buffer[] {
        const payloads: Buffer[] = [];
        let offset = 0;
        while (offset < bytes.length) {
          const header = bytes.subarray(offset, offset + 4).toString("ascii");
          expect(header).toMatch(/^[0-9a-f]{4}$/);
          const size = Number.parseInt(header, 16);
          if (size === 0) {
            expect(offset + 4).toBe(bytes.length);
            return payloads;
          }
          expect(size).toBeGreaterThan(4);
          expect(size).toBeLessThanOrEqual(65520);
          expect(offset + size).toBeLessThanOrEqual(bytes.length);
          payloads.push(bytes.subarray(offset + 4, offset + size));
          offset += size;
        }
        throw new Error("missing final flush");
      }
      const packets = decode(Buffer.from(await response.arrayBuffer()));
      const data: Buffer[] = [];
      const progress: Buffer[] = [];
      for (const packet of packets) {
        expect([1, 2]).toContain(packet[0]);
        (packet[0] === 1 ? data : progress).push(packet.subarray(1));
      }
      expect(data.length).toBeGreaterThan(1);
      expect(Buffer.concat(progress).toString("utf8")).toBe(`${PUSH_REFUSALS.MULTIPLE_REFS}\n`);
      expect(decode(Buffer.concat(data)).map((line) => line.toString("utf8"))).toEqual([
        "unpack ok\n",
        ...refs.map((ref) => `ng ${ref} ${PUSH_REFUSALS.MULTIPLE_REFS}\n`),
      ]);
    } finally {
      principal.scopes = ["mcp:read"];
      storedAcl.set(id, ["read"]);
    }
  });

  it.each(Object.keys(PUSH_REFUSALS) as PushRefusalCode[])(
    "reports %s against the ref, not as a 503",
    async (refusal) => {
      const { app } = fixture({ push: true });
      storedAcl.set(id, ["read", "propose"]);
      principal.scopes = ["mcp:read", "mcp:write"];
      receivePush.mockRejectedValueOnce(new PushRefusedError(refusal));
      try {
        const report = await post(app, branchBody("report-status"));
        expect(report.status).toBe(200);
        expect(await report.text()).toBe(
          `${pkt("unpack ok\n")}${pkt(`ng refs/heads/topic ${PUSH_REFUSALS[refusal]}\n`)}0000`,
        );
        receivePush.mockRejectedValueOnce(new PushRefusedError(refusal));
        const bare = await post(app, branchBody("agent=git/2"));
        expect(bare.status).toBe(409);
        expect(await bare.text()).toBe(`${PUSH_REFUSALS[refusal]}\n`);
      } finally {
        receivePush.mockReset();
        principal.scopes = ["mcp:read"];
        storedAcl.set(id, ["read"]);
      }
    },
  );
  it("logs an unexpected push failure before its 503, without the credential", async () => {
    const { app } = fixture({ push: true });
    storedAcl.set(id, ["read", "propose"]);
    principal.scopes = ["mcp:read", "mcp:write"];
    receivePush.mockRejectedValueOnce(
      Object.assign(new Error(`Command failed: git merge-base CANARY_GIT ${pat}`), { status: 128 }),
    );
    const logged = captureLog();
    try {
      const response = await post(app, branchBody("report-status"));
      expect(response.status).toBe(503);
      const lines = logged.records.map((record) => JSON.stringify(record));
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!);
      // Exactly the fixed record: no message, stack or cause text.
      expect(Object.keys(record).sort()).toEqual(
        ["errorClass", "errorCode", "kbId", "level", "message", "opId", "service", "site"].sort(),
      );
      expect(record).toMatchObject({
        site: "git-http",
        errorClass: "Error",
        errorCode: 128,
        service: "push",
        kbId: id,
      });
      expect(lines[0]).not.toContain("CANARY_GIT");
      expect(lines[0]).not.toContain(pat);
    } finally {
      logged.restore();
      receivePush.mockReset();
      principal.scopes = ["mcp:read"];
      storedAcl.set(id, ["read"]);
    }
  });
});
describe("Git HTTP admission", () => {
  it("refuses discovery and upload before authentication when native ownership is unconfirmed", async () => {
    const { app, admit } = fixture();
    const originalSocket = process.env.KB_SUPERVISOR_SOCK;
    delete process.env.KB_SUPERVISOR_SOCK;
    await closeAdmission();
    try {
      for (const path of ["info/refs?service=git-upload-pack", "git-upload-pack"]) {
        expect((await app.request(`/git/${id}.git/${path}`)).status).toBe(503);
      }
      expect(admit).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
    } finally {
      if (originalSocket !== undefined) process.env.KB_SUPERVISOR_SOCK = originalSocket;
      resetAdmissionForTests();
    }
  });
  it.each([
    { cookie: "session=valid" },
    { authorization: basic("eyJ.jwt.signature") },
    { authorization: "Bearer token" },
    {},
  ])("requires PAT Basic even for discovery", async (headers) => {
    const { app, admit } = fixture();
    const response = await app.request(`/git/${id}.git/info/refs?service=git-upload-pack`, {
      headers,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(admit).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
  });
  it("uses full admission and live read; no-read discovery is 404", async () => {
    const { app, store, verifier } = fixture();
    expect(
      (
        await app.request(`/git/${id}.git/info/refs?service=git-upload-pack`, {
          headers: { authorization: basic() },
        })
      ).status,
    ).toBe(200);
    expect(verifier.inspect).toHaveBeenCalled();
    store.loadKb.mockResolvedValue(null as never);
    expect(
      (
        await app.request(`/git/${id}.git/info/refs?service=git-upload-pack`, {
          headers: { authorization: basic() },
        })
      ).status,
    ).toBe(404);
    expect(backend).toHaveBeenCalledTimes(1);
  });
  it("Git fetch needs the read tool group and Git push needs edit", async () => {
    const { app, verifier } = fixture();
    const groups = (toolGroups: string[]) =>
      verifier.inspect.mockResolvedValue({
        generationActive: true,
        instanceEnabled: true,
        expired: false,
        banned: false,
        twoFactorSatisfied: true,
        toolGroups,
      });
    const discover = async (service: string) =>
      (
        await app.request(`/git/${id}.git/info/refs?service=${service}`, {
          headers: { authorization: basic() },
        })
      ).status;
    // Authenticated but not permitted: 403 (Git keeps the credential), not 401.
    groups(["edit"]);
    expect(await discover("git-upload-pack")).toBe(403);
    groups(["read"]);
    expect(await discover("git-upload-pack")).toBe(200);
    // An edit-less PAT never reaches receive-pack, even before push is configured.
    expect(await discover("git-receive-pack")).toBe(403);
    groups(["read", "edit"]);
    expect(await discover("git-receive-pack")).toBe(501);
    expect(backend).toHaveBeenCalledTimes(1);
  });
  it("serves digit-leading generated KB ids (any protocol kbId)", async () => {
    const { app, store } = fixture();
    for (const kbId of ["0e0vluxcgs5wyhelc42wdzz3", `9${"z".repeat(31)}`]) {
      storedAcl.set(kbId, ["read"]);
      store.loadKb.mockResolvedValue({ id: kbId, ownerId: "user", state: "ACTIVE" as const });
      const response = await app.request(`/git/${kbId}.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: basic() },
      });
      expect(response.status, kbId).toBe(200);
      expect(backend.mock.lastCall?.[0].env.PATH_INFO).toBe(`/kb_${kbId}.git/info/refs`);
      storedAcl.delete(kbId);
    }
    expect(backend).toHaveBeenCalledTimes(2);
  });
  it.each([
    `/git/${id}.git/info/refs?service=git-upload-pack&PATH_INFO=/other`,
    `/git/${id}.git/objects/aa`,
    "/git/%2e%2e%2fsecret.git/info/refs?service=git-upload-pack",
  ])("rejects malicious route/query %s", async (path) => {
    const { app } = fixture();
    expect(
      (await app.request(path, { headers: { authorization: basic() } })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("receive-pack discovery and POST fail explicitly before body reads or spawning", async () => {
    const { app } = fixture();
    let pulled = 0;
    for (const path of ["info/refs?service=git-receive-pack", "git-receive-pack"]) {
      const post = path === "git-receive-pack";
      const response = await app.request(`/git/${id}.git/${path}`, {
        method: post ? "POST" : "GET",
        headers: { authorization: basic(), "content-length": String(51 * 1024 * 1024) },
        ...(post
          ? {
              body: new ReadableStream(
                {
                  pull() {
                    pulled++;
                  },
                },
                { highWaterMark: 0 },
              ),
              duplex: "half",
            }
          : {}),
      } as RequestInit);
      expect(response.status).toBe(501);
      expect(await response.text()).toContain("RECEIVE_PACK_UNAVAILABLE");
    }
    expect(pulled).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });
  it("shutdown closes admission and aborts an active backend before drain returns", async () => {
    let aborted = false;
    backend.mockImplementation(
      ({ signal, onDone }: { signal: AbortSignal; onDone(): Promise<void> }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            void onDone().then(() => reject(new Error("cancelled")));
          });
        }),
    );
    const { app, git } = fixture();
    const pending = app.request(`/git/${id}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic() },
    });
    await vi.waitFor(() => expect(backend).toHaveBeenCalledOnce());
    await git.close();
    expect(aborted).toBe(true);
    expect((await pending).status).toBe(503);
    expect(
      (await app.request(`/git/${id}.git/info/refs`, { headers: { authorization: basic() } }))
        .status,
    ).toBe(503);
  });
  it("retains the HTTP completion owner after caller failure until CGI confirms drain", async () => {
    let onDone!: () => Promise<void>;
    backend.mockImplementation((input: { signal: AbortSignal; onDone(): Promise<void> }) => {
      onDone = input.onDone;
      return new Promise((_, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("drain still pending")));
      });
    });
    const { app, git } = fixture();
    const pending = app.request(`/git/${id}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic() },
    });
    await vi.waitFor(() => expect(backend).toHaveBeenCalledOnce());
    let closed = false;
    const closing = git.close().then(() => {
      closed = true;
    });
    expect((await pending).status).toBe(503);
    expect(closed).toBe(false);
    await onDone();
    await closing;
    expect(closed).toBe(true);
    await onDone();
  });
});
