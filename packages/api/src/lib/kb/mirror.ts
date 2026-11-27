import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recordAuditEvent } from "./audit";
import {
  type DeployKeyIdentity,
  encryptDeployKey,
  generateDeployKey,
  MAX_APPROVED_HOST_KEYS,
  normalizeHostKeyEntries,
  parseApprovedHostKeys,
} from "./deploy-key";
import type { DnsLookupFn } from "./egress";
import { requireKbMasterKey } from "./envelope";
import { fromAdmissionError, KbDomainError } from "./errors";
import { generateKnowledgeBaseId } from "./id";
import { enqueueDurableJobOnQuery } from "./jobs";
import { chargeKbMutation } from "./limits";
import type { LockQuery } from "./lock";
import {
  assertHostKeysTrusted,
  checkHostKey,
  hostKeyVerdict,
  mirrorProvider,
  normalizeMirrorRemote,
} from "./mirror-remote";
import {
  actorKeyForUser,
  canonicalRequestHash,
  findOperationIntent,
  recordFinalizedReceipt,
} from "./operation-intent";
import { authorize, sqlAuthorityStore } from "./permissions";
import type { Principal } from "./principal";
import { keySchema } from "./protocol/common";
import type { KbRuntimeConfig } from "./runtime";
import { type SshConnect, scanSshHostKeys } from "./ssh-host-scan";
import { assertMirrorHostEgress, parseMirrorSshUrl, resolveMirrorHostAddress } from "./ssh-url";

/*
 * Human-only, manage-bit mirror control plane. No MCP
 * tool, no private-key read path. Configure/rotate only ever create a PENDING
 * key; the dedicated worker verifies it and calls activateVerifiedDeployKey.
 *
 * Lock/ordering: every mutation runs in one authority-locked SQL transaction
 * and takes `kb_remote ... FOR UPDATE` after authorization. Executor drains run
 * OUTSIDE any transaction, between two authority transactions.
 */

type Runtime = Pick<KbRuntimeConfig, "coordinator" | "ratePort">;
const kbIdSchema = z.string().regex(/^[a-z0-9]{24,32}$/);

export const mirrorStatusInput = z.strictObject({ kbId: kbIdSchema });
export const mirrorConfigureInput = z.strictObject({
  kbId: kbIdSchema,
  url: z.string().min(1).max(1024),
  hostKeys: z.array(z.string().max(8300)).min(1).max(MAX_APPROVED_HOST_KEYS),
  /** PUBLISHED: matched a provider's published fingerprints (re-checked here).
   * CONFIRMED: the user compared the fingerprints or pasted the keys themselves. */
  hostKeyCheck: z.enum(["PUBLISHED", "CONFIRMED"]),
  idempotencyKey: keySchema,
});
export const mirrorMutationInput = z.strictObject({ kbId: kbIdSchema, idempotencyKey: keySchema });
/** The override names the exact pending key the user saw fail. */
export const mirrorEnableUntestedInput = z.strictObject({
  kbId: kbIdSchema,
  keyId: z.string().min(1).max(64),
  idempotencyKey: keySchema,
});
export const mirrorInspectInput = z.strictObject({
  kbId: kbIdSchema,
  url: z.string().min(1).max(1024),
});

const providerIdSchema = z.enum(["github", "gitlab", "bitbucket"]);
const hostKeyView = z.object({
  algorithm: z.string(),
  key: z.string(),
  fingerprint: z.string(),
  check: z.enum(["PUBLISHED", "MISMATCH", "UNPINNED"]),
});
/** What the setup guide needs about a remote: canonical URL, provider and checked host keys. */
export const mirrorInspectSchema = z.object({
  url: z.string(),
  host: z.string(),
  port: z.number().int(),
  provider: providerIdSchema.nullable(),
  deployKeyUrl: z.string().nullable(),
  fingerprintsSource: z.string().nullable(),
  reachable: z.boolean(),
  hostKeys: z.array(hostKeyView),
  verdict: z.enum(["PUBLISHED", "CONFIRM", "MISMATCH", "UNREACHABLE"]),
});
export type MirrorInspection = z.infer<typeof mirrorInspectSchema>;
const attemptView = z.object({
  attemptId: z.string(),
  action: z.enum(["PUSH", "ACTIVATE"]),
  state: z.string(),
  resultCode: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const mirrorKeyViewSchema = z.object({
  keyId: z.string(),
  keyVersion: z.number().int(),
  remoteVersion: z.number().int(),
  state: z.enum(["PENDING", "ACTIVE"]),
  url: z.string(),
  hostKeys: z.array(hostKeyView),
  publicKey: z.string(),
  fingerprint: z.string(),
  createdAt: z.string(),
  provider: providerIdSchema.nullable(),
  deployKeyUrl: z.string().nullable(),
});
/** Public projection only. Non-strict objects: parsing strips any other field. */
export const mirrorStatusSchema = z.object({
  kbId: z.string(),
  state: z.enum(["DISCONNECTED", "PENDING", "ACTIVE"]),
  remoteVersion: z.number().int(),
  active: mirrorKeyViewSchema.nullable(),
  pending: mirrorKeyViewSchema.nullable(),
  pushEnabled: z.boolean(),
  /** Newest attempt of any kind (drives polling while one is in flight). */
  lastAttempt: attemptView.nullable().default(null),
  /** Newest connection test of the pending key. */
  lastTest: attemptView.nullable().default(null),
  /** Newest push to the active remote URL. */
  lastPush: attemptView.nullable().default(null),
});
export const mirrorResultSchema = z.object({
  operationId: z.string(),
  mirror: mirrorStatusSchema,
});
export type MirrorStatus = z.infer<typeof mirrorStatusSchema>;
export type MirrorResult = z.infer<typeof mirrorResultSchema>;

/** Executor drain port: returns only once every listed reserved attempt has
 * stopped (process group exited) and been settled out of RESERVED. */
export type MirrorExecutorPort = {
  drain(kbId: string, attemptIds: readonly string[]): Promise<void>;
};
let executor: MirrorExecutorPort | undefined;
export function registerMirrorExecutor(port: MirrorExecutorPort): void {
  executor = port;
}
export function resetMirrorExecutorForTests(): void {
  executor = undefined;
}
export function requireMirrorExecutor(): MirrorExecutorPort {
  if (!executor) throw new KbDomainError("STORAGE_UNAVAILABLE", "Mirror executor unavailable");
  return executor;
}

type RemoteRow = {
  remoteVersion: number;
  state: "DISCONNECTED" | "PENDING" | "ACTIVE";
  activeKeyId: string | null;
  pendingKeyId: string | null;
};
type KeyRow = {
  id: string;
  keyVersion: number;
  remoteVersion: number;
  url: string;
  hostKeys: string[];
  publicKey: string;
  fingerprint: string;
  state: string;
  createdAt: Date;
};

async function asManager<T>(
  runtime: Runtime,
  principal: Principal,
  kbId: string,
  run: (query: LockQuery) => Promise<T>,
): Promise<T> {
  // Mirror control is human-only: a token's manage bit never reaches it.
  if (principal.kind !== "browser") throw new KbDomainError("FORBIDDEN", "Forbidden");
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        try {
          await authorize({
            store: sqlAuthorityStore(query),
            principal,
            kbId,
            operation: "manage",
            query,
          });
        } catch (error) {
          throw fromAdmissionError(error) ?? error;
        }
        return run(query);
      }),
  }) as Promise<T>;
}

async function lockRemote(query: LockQuery, kbId: string): Promise<RemoteRow> {
  await query(`INSERT INTO kb_remote ("kbId") VALUES ($1) ON CONFLICT ("kbId") DO NOTHING`, [kbId]);
  const rows = await query<RemoteRow>(
    `SELECT "remoteVersion", state::text AS state, "activeKeyId", "pendingKeyId"
       FROM kb_remote WHERE "kbId"=$1 FOR UPDATE`,
    [kbId],
  );
  return rows.rows[0]!;
}

function keyView(row: KeyRow | undefined) {
  if (!row) return null;
  const remote = parseMirrorSshUrl(row.url);
  const provider = mirrorProvider(remote);
  return {
    keyId: row.id,
    keyVersion: row.keyVersion,
    remoteVersion: row.remoteVersion,
    state: row.state as "PENDING" | "ACTIVE",
    url: row.url,
    hostKeys: parseApprovedHostKeys(row.hostKeys).map((key) => ({
      ...key,
      check: checkHostKey(remote, key),
    })),
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.toISOString(),
    provider: provider?.id ?? null,
    deployKeyUrl: provider?.deployKeyUrl(remote.path) ?? null,
  };
}

type AttemptRow = {
  attemptId: string;
  action: string;
  state: string;
  resultCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};
/** Newest attempt matching `filter` (bound as $2..). Bounded to one row. */
async function newestAttempt(
  query: LockQuery,
  kbId: string,
  filter: string,
  params: unknown[],
): Promise<z.infer<typeof attemptView> | null> {
  const row = (
    await query<AttemptRow>(
      `SELECT a.id AS "attemptId",COALESCE(j.desired->>'action','PUSH') AS action,
              a.state::text AS state,a."resultCode",a."createdAt",a."finishedAt"
         FROM kb_mirror_attempt a
         JOIN kb_deploy_key_version k ON k."kbId"=a."kbId" AND k.id=a."keyId"
         LEFT JOIN durable_job j ON j.id=a.id::text
        WHERE a."kbId"=$1 ${filter}
        ORDER BY a."createdAt" DESC,a.id DESC LIMIT 1`,
      [kbId, ...params],
    )
  ).rows[0];
  if (!row) return null;
  return attemptView.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });
}

export async function loadMirrorStatus(query: LockQuery, kbId: string): Promise<MirrorStatus> {
  const remote = (
    await query<RemoteRow>(
      `SELECT "remoteVersion", state::text AS state, "activeKeyId", "pendingKeyId"
         FROM kb_remote WHERE "kbId"=$1`,
      [kbId],
    )
  ).rows[0];
  if (!remote)
    return {
      kbId,
      state: "DISCONNECTED",
      remoteVersion: 0,
      active: null,
      pending: null,
      pushEnabled: false,
      lastAttempt: null,
      lastTest: null,
      lastPush: null,
    };
  // Public columns only: ciphertext is never selected for a projection.
  const keys = await query<KeyRow>(
    `SELECT id,"keyVersion","remoteVersion",url,"hostKeys","publicKey",fingerprint,state::text AS state,"createdAt"
       FROM kb_deploy_key_version WHERE "kbId"=$1 AND id = ANY($2::text[])`,
    [kbId, [remote.activeKeyId, remote.pendingKeyId].filter(Boolean)],
  );
  const byId = new Map(keys.rows.map((row) => [row.id, row]));
  const active = remote.activeKeyId ? byId.get(remote.activeKeyId) : undefined;
  return mirrorStatusSchema.parse({
    kbId,
    state: remote.state,
    remoteVersion: remote.remoteVersion,
    active: keyView(active),
    pending: keyView(remote.pendingKeyId ? byId.get(remote.pendingKeyId) : undefined),
    pushEnabled: remote.state === "ACTIVE" && !!remote.activeKeyId,
    lastAttempt: await newestAttempt(query, kbId, "", []),
    lastTest: remote.pendingKeyId
      ? await newestAttempt(query, kbId, `AND a."keyId"=$2 AND j.desired->>'action'='ACTIVATE'`, [
          remote.pendingKeyId,
        ])
      : null,
    lastPush: active
      ? await newestAttempt(
          query,
          kbId,
          `AND k.url=$2 AND COALESCE(j.desired->>'action','PUSH')='PUSH'`,
          [active.url],
        )
      : null,
  });
}

async function replay(
  query: LockQuery,
  userId: string,
  input: { kbId: string; idempotencyKey: string },
  operation: string,
  requestHash: string,
): Promise<MirrorResult | null> {
  const prior = await findOperationIntent(query, {
    actorKey: actorKeyForUser(userId),
    kbId: input.kbId,
    operation,
    idempotencyKey: input.idempotencyKey,
  });
  if (!prior) return null;
  if (prior.requestHash !== requestHash)
    throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
  const body = z.object({ operationId: z.string() }).parse(prior.responseBody);
  return { operationId: body.operationId, mirror: await loadMirrorStatus(query, input.kbId) };
}

async function finish(
  query: LockQuery,
  userId: string,
  input: { kbId: string; idempotencyKey: string },
  operation: string,
  requestHash: string,
  metadata: { state: string; requestId?: string },
): Promise<MirrorResult> {
  const operationId = randomUUID();
  const mirror = await loadMirrorStatus(query, input.kbId);
  await recordAuditEvent(query, {
    opId: operationId,
    action: operation.toLowerCase(),
    outcome: "SUCCESS",
    actorKey: actorKeyForUser(userId),
    actorUserId: userId,
    actorUserIdSnapshot: userId,
    kbId: input.kbId,
    revision: String(mirror.remoteVersion),
    metadata,
  });
  // The receipt stores only the operation id; replies are re-projected.
  await recordFinalizedReceipt(query, {
    ...input,
    actorUserId: userId,
    operation,
    requestHash,
    opId: operationId,
    responseBody: { operationId },
  });
  return { operationId, mirror };
}

/**
 * Destroy ciphertext of every retired key no RESERVED attempt still pins.
 * Keys with an in-flight reservation stay RETIRED until the executor drains
 * them and calls this again.
 */
export async function destroyDrainedDeployKeys(query: LockQuery, kbId: string): Promise<void> {
  await query(
    `UPDATE kb_deploy_key_version k SET ciphertext=NULL,state='DESTROYED',"destroyedAt"=now()
      WHERE k."kbId"=$1 AND k.state='RETIRED'
        AND NOT EXISTS (SELECT 1 FROM kb_mirror_attempt a
                         WHERE a."kbId"=k."kbId" AND a."keyId"=k.id AND a.state='RESERVED')`,
    [kbId],
  );
}

async function createPendingKey(
  query: LockQuery,
  kbId: string,
  userId: string,
  remote: RemoteRow,
  target: { url: string; hostKeys: string[] },
  master: Buffer,
): Promise<string> {
  if (remote.pendingKeyId) {
    await query(
      `UPDATE kb_deploy_key_version SET state='RETIRED',"retiredAt"=now() WHERE "kbId"=$1 AND id=$2`,
      [kbId, remote.pendingKeyId],
    );
    await destroyDrainedDeployKeys(query, kbId);
  }
  const next = await query<{ next: number }>(
    `SELECT COALESCE(MAX("keyVersion"),0)+1 AS next FROM kb_deploy_key_version WHERE "kbId"=$1`,
    [kbId],
  );
  const identity: DeployKeyIdentity = {
    kbId,
    remoteVersion: remote.remoteVersion + 1,
    keyVersion: Number(next.rows[0]!.next),
  };
  const generated = generateDeployKey();
  const id = generateKnowledgeBaseId();
  try {
    await query(
      `INSERT INTO kb_deploy_key_version
         (id,"kbId","keyVersion","remoteVersion",url,"hostKeys","publicKey",fingerprint,ciphertext,state,"createdBy")
       VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,'PENDING',$10)`,
      [
        id,
        kbId,
        identity.keyVersion,
        identity.remoteVersion,
        target.url,
        target.hostKeys,
        generated.publicKey,
        generated.fingerprint,
        encryptDeployKey(generated.seed, identity, master),
        userId,
      ],
    );
  } finally {
    generated.seed.destroy();
  }
  await query(
    `UPDATE kb_remote SET "pendingKeyId"=$2,
            state=(CASE WHEN "activeKeyId" IS NULL THEN 'PENDING' ELSE 'ACTIVE' END)::"KbRemoteState",
            "updatedAt"=now()
      WHERE "kbId"=$1`,
    [kbId, id],
  );
  return id;
}

export async function getMirrorStatus(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorStatusInput>,
): Promise<MirrorStatus> {
  const input = mirrorStatusInput.parse(raw);
  return asManager(runtime, principal, input.kbId, (query) => loadMirrorStatus(query, input.kbId));
}

export async function configureMirror(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorConfigureInput>,
  masterKeyValue: string | undefined,
  options: { lookup?: DnsLookupFn } = {},
): Promise<MirrorResult> {
  const input = mirrorConfigureInput.parse(raw);
  const parsed = normalizeMirrorRemote(input.url);
  const approved = parseApprovedHostKeys(normalizeHostKeyEntries(input.hostKeys, parsed));
  assertHostKeysTrusted(parsed, approved, input.hostKeyCheck);
  const hostKeys = approved.map((k) => k.key);
  await assertMirrorHostEgress(parsed, options.lookup);
  const requestHash = canonicalRequestHash({
    kbId: input.kbId,
    url: parsed.url,
    hostKeys,
    hostKeyCheck: input.hostKeyCheck,
    idempotencyKey: input.idempotencyKey,
  });
  const master = requireKbMasterKey(masterKeyValue);
  try {
    return await asManager(runtime, principal, input.kbId, async (query) => {
      const prior = await replay(query, principal.userId, input, "MIRROR_CONFIGURE", requestHash);
      if (prior) return prior;
      await chargeKbMutation(runtime.ratePort, actorKeyForUser(principal.userId), input.kbId);
      const remote = await lockRemote(query, input.kbId);
      const keyId = await createPendingKey(
        query,
        input.kbId,
        principal.userId,
        remote,
        { url: parsed.url, hostKeys },
        master,
      );
      return finish(query, principal.userId, input, "MIRROR_CONFIGURE", requestHash, {
        state: "PENDING",
        requestId: keyId,
      });
    });
  } finally {
    master.fill(0);
  }
}

/** Process-wide cap on concurrent host-key scans (each opens up to three sockets). */
const MAX_CONCURRENT_SCANS = 4;
let activeScans = 0;

/**
 * Setup step 1-2: normalise the remote, then fetch and check its SSH host keys.
 * Authorization and the mutation budget are charged before any lookup or
 * connection; the scan connects only to an address that passed the egress
 * policy. Nothing is stored: the result is a proposal the user acts on.
 */
export async function inspectMirrorRemote(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorInspectInput>,
  options: {
    lookup?: DnsLookupFn;
    resolveAddress?: (host: string) => Promise<string>;
    connect?: SshConnect;
    timeoutMs?: number;
  } = {},
): Promise<MirrorInspection> {
  const input = mirrorInspectInput.parse(raw);
  const parsed = normalizeMirrorRemote(input.url);
  await asManager(runtime, principal, input.kbId, async () => {
    await chargeKbMutation(runtime.ratePort, actorKeyForUser(principal.userId), input.kbId);
  });
  const address = options.resolveAddress
    ? await options.resolveAddress(parsed.host)
    : await resolveMirrorHostAddress(parsed, options.lookup);
  if (activeScans >= MAX_CONCURRENT_SCANS)
    throw new KbDomainError("RATE_LIMITED", "Too many host-key scans");
  activeScans++;
  let scan: Awaited<ReturnType<typeof scanSshHostKeys>>;
  try {
    scan = await scanSshHostKeys(
      { address, port: parsed.port },
      { connect: options.connect, timeoutMs: options.timeoutMs },
    );
  } finally {
    activeScans--;
  }
  const provider = mirrorProvider(parsed);
  return mirrorInspectSchema.parse({
    url: parsed.url,
    host: parsed.host,
    port: parsed.port,
    provider: provider?.id ?? null,
    deployKeyUrl: provider?.deployKeyUrl(parsed.path) ?? null,
    fingerprintsSource: provider?.fingerprintsSource ?? null,
    reachable: scan.reachable,
    hostKeys: scan.keys.map((key) => ({ ...key, check: checkHostKey(parsed, key) })),
    verdict: hostKeyVerdict(parsed, scan.keys),
  });
}

/** Result codes a connection test can fail with that an override may not skip. */
const NOT_OVERRIDABLE = new Set(["HOST_KEY_MISMATCH"]);

/**
 * Explicit, confirmed override: enable a first mirror whose connection test
 * failed. Only for a first key (never replaces a working active key), only
 * after a finished failed test of this exact pending key, and never past a
 * host-key mismatch. Every later push still enforces the pinned host keys.
 */
export async function enableUntestedMirror(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorEnableUntestedInput>,
): Promise<MirrorResult> {
  const input = mirrorEnableUntestedInput.parse(raw);
  const requestHash = canonicalRequestHash(input);
  return asManager(runtime, principal, input.kbId, async (query) => {
    const prior = await replay(
      query,
      principal.userId,
      input,
      "MIRROR_ENABLE_UNTESTED",
      requestHash,
    );
    if (prior) return prior;
    const remote = await lockRemote(query, input.kbId);
    // A key created since the user's confirmation (another tab) is never enabled by it.
    if (remote.activeKeyId || !remote.pendingKeyId || remote.pendingKeyId !== input.keyId)
      throw new KbDomainError("CONFLICT", "No first pending key to enable");
    const test = await newestAttempt(
      query,
      input.kbId,
      `AND a."keyId"=$2 AND j.desired->>'action'='ACTIVATE'`,
      [remote.pendingKeyId],
    );
    if (test?.state !== "FAILED" || NOT_OVERRIDABLE.has(test.resultCode ?? ""))
      throw new KbDomainError("CONFLICT", "A failed connection test is required first");
    await chargeKbMutation(runtime.ratePort, actorKeyForUser(principal.userId), input.kbId);
    await activateVerifiedDeployKey(query, { kbId: input.kbId, keyId: remote.pendingKeyId });
    return finish(query, principal.userId, input, "MIRROR_ENABLE_UNTESTED", requestHash, {
      state: "ACTIVE",
      requestId: remote.pendingKeyId,
    });
  });
}

export async function rotateMirrorKey(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorMutationInput>,
  masterKeyValue: string | undefined,
): Promise<MirrorResult> {
  const input = mirrorMutationInput.parse(raw);
  const requestHash = canonicalRequestHash(input);
  const master = requireKbMasterKey(masterKeyValue);
  try {
    return await asManager(runtime, principal, input.kbId, async (query) => {
      const prior = await replay(query, principal.userId, input, "MIRROR_ROTATE", requestHash);
      if (prior) return prior;
      const remote = await lockRemote(query, input.kbId);
      if (!remote.activeKeyId || remote.state !== "ACTIVE")
        throw new KbDomainError("CONFLICT", "No active mirror to rotate");
      const active = (
        await query<{ url: string; hostKeys: string[] }>(
          `SELECT url,"hostKeys" FROM kb_deploy_key_version WHERE "kbId"=$1 AND id=$2 AND state='ACTIVE'`,
          [input.kbId, remote.activeKeyId],
        )
      ).rows[0];
      if (!active) throw new KbDomainError("CONFLICT", "No active mirror to rotate");
      await chargeKbMutation(runtime.ratePort, actorKeyForUser(principal.userId), input.kbId);
      const keyId = await createPendingKey(
        query,
        input.kbId,
        principal.userId,
        remote,
        active,
        master,
      );
      return finish(query, principal.userId, input, "MIRROR_ROTATE", requestHash, {
        state: "PENDING",
        requestId: keyId,
      });
    });
  } finally {
    master.fill(0);
  }
}

/**
 * Phase A of disconnect/teardown, inside the caller's authority transaction:
 * bump remoteVersion (once), retire live keys, cancel unreserved attempts and
 * destroy every key no reservation pins. Returns attempts still RESERVED.
 */
async function disconnectInTransaction(query: LockQuery, kbId: string): Promise<string[]> {
  const remote = (
    await query<RemoteRow>(
      `SELECT "remoteVersion", state::text AS state, "activeKeyId", "pendingKeyId"
         FROM kb_remote WHERE "kbId"=$1 FOR UPDATE`,
      [kbId],
    )
  ).rows[0];
  if (!remote) return [];
  if (remote.state !== "DISCONNECTED" || remote.activeKeyId || remote.pendingKeyId) {
    await query(
      `UPDATE kb_remote SET "remoteVersion"="remoteVersion"+1,state='DISCONNECTED',
              "activeKeyId"=NULL,"pendingKeyId"=NULL,"updatedAt"=now() WHERE "kbId"=$1`,
      [kbId],
    );
  }
  await query(
    `UPDATE kb_deploy_key_version SET state='RETIRED',"retiredAt"=COALESCE("retiredAt",now())
      WHERE "kbId"=$1 AND state IN ('PENDING','ACTIVE')`,
    [kbId],
  );
  await query(
    `UPDATE kb_mirror_attempt SET state='CANCELLED',"finishedAt"=now(),"resultCode"='DISCONNECTED'
      WHERE "kbId"=$1 AND state='QUEUED'`,
    [kbId],
  );
  await destroyDrainedDeployKeys(query, kbId);
  // pagination:audited — bounded by the worker mirror concurrency (KB_LIMITS.workerMirrors).
  const reserved = await query<{ id: string }>(
    `SELECT id FROM kb_mirror_attempt WHERE "kbId"=$1 AND state='RESERVED' ORDER BY id`,
    [kbId],
  );
  return reserved.rows.map((row) => row.id);
}

export async function disconnectMirror(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorMutationInput>,
): Promise<MirrorResult> {
  const input = mirrorMutationInput.parse(raw);
  const requestHash = canonicalRequestHash(input);
  const phaseA = await asManager(runtime, principal, input.kbId, async (query) => {
    const prior = await replay(query, principal.userId, input, "MIRROR_DISCONNECT", requestHash);
    if (prior) return { done: prior };
    await chargeKbMutation(runtime.ratePort, actorKeyForUser(principal.userId), input.kbId);
    const reserved = await disconnectInTransaction(query, input.kbId);
    if (reserved.length > 0) return { done: null, reserved };
    return {
      done: await finish(query, principal.userId, input, "MIRROR_DISCONNECT", requestHash, {
        state: "DISCONNECTED",
      }),
    };
  });
  if (phaseA.done) return phaseA.done;
  // Reserved attempts may be using a key right now: the executor must kill and
  // drain them before any key is destroyed or success is returned.
  if (executor) await executor.drain(input.kbId, phaseA.reserved ?? []);
  else {
    // Cross-process drain acknowledgement is the durable RESERVED state, never
    // an in-process registry. The worker polls the disconnected remote and kills
    // its group; it settles RESERVED only after key unlink and process drain.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const count = await asManager(
        runtime,
        principal,
        input.kbId,
        async (query) =>
          (
            await query<{ count: number }>(
              `SELECT count(*)::int AS count FROM kb_mirror_attempt WHERE "kbId"=$1 AND state='RESERVED'`,
              [input.kbId],
            )
          ).rows[0]!.count,
      );
      if (!count) break;
      if (Date.now() >= deadline)
        throw new KbDomainError("STORAGE_UNAVAILABLE", "Mirror attempt still draining");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return asManager(runtime, principal, input.kbId, async (query) => {
    const prior = await replay(query, principal.userId, input, "MIRROR_DISCONNECT", requestHash);
    if (prior) return prior;
    const still = await disconnectInTransaction(query, input.kbId);
    if (still.length > 0)
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Mirror attempt still draining");
    return finish(query, principal.userId, input, "MIRROR_DISCONNECT", requestHash, {
      state: "DISCONNECTED",
    });
  });
}

/**
 * Transfer / tombstone / account-removal teardown inside the owning authority
 * transaction. Keys pinned by a RESERVED attempt keep their ciphertext as
 * RETIRED until the executor drains them (`destroyDrainedDeployKeys`); no new reservation can use them because the
 * remote version and active key have changed.
 */
export async function teardownMirror(ctx: { query: LockQuery; kbId: string }): Promise<void> {
  await disconnectInTransaction(ctx.query, ctx.kbId);
}

/**
 * Worker-side CAS after successful verification of the exact pending key
 * (and the manager's confirmed override in `enableUntestedMirror`).
 * Switches active key and remoteVersion atomically; cancels queued
 * attempts pinned to the old version; old key is destroyed once drained.
 */
export async function activateVerifiedDeployKey(
  query: LockQuery,
  input: { kbId: string; keyId: string },
): Promise<void> {
  const remote = (
    await query<RemoteRow>(
      `SELECT "remoteVersion", state::text AS state, "activeKeyId", "pendingKeyId"
         FROM kb_remote WHERE "kbId"=$1 FOR UPDATE`,
      [input.kbId],
    )
  ).rows[0];
  const key = (
    await query<{ remoteVersion: number; state: string; hasCiphertext: boolean }>(
      `SELECT "remoteVersion",state::text AS state,(ciphertext IS NOT NULL) AS "hasCiphertext"
         FROM kb_deploy_key_version WHERE "kbId"=$1 AND id=$2 FOR UPDATE`,
      [input.kbId, input.keyId],
    )
  ).rows[0];
  if (
    !remote ||
    !key ||
    remote.pendingKeyId !== input.keyId ||
    key.state !== "PENDING" ||
    !key.hasCiphertext ||
    key.remoteVersion !== remote.remoteVersion + 1
  )
    throw new KbDomainError("CONFLICT", "Pending key changed");
  if (remote.activeKeyId)
    await query(
      `UPDATE kb_deploy_key_version SET state='RETIRED',"retiredAt"=now() WHERE "kbId"=$1 AND id=$2`,
      [input.kbId, remote.activeKeyId],
    );
  await query(
    `UPDATE kb_deploy_key_version SET state='ACTIVE',"activatedAt"=now() WHERE "kbId"=$1 AND id=$2`,
    [input.kbId, input.keyId],
  );
  await query(
    `UPDATE kb_remote SET "remoteVersion"=$2,state='ACTIVE',"activeKeyId"=$3,"pendingKeyId"=NULL,"updatedAt"=now()
      WHERE "kbId"=$1`,
    [input.kbId, key.remoteVersion, input.keyId],
  );
  await query(
    `UPDATE kb_mirror_attempt SET state='CANCELLED',"finishedAt"=now(),"resultCode"='SUPERSEDED'
      WHERE "kbId"=$1 AND state='QUEUED' AND "remoteVersion"<>$2`,
    [input.kbId, key.remoteVersion],
  );
  await destroyDrainedDeployKeys(query, input.kbId);
}

/** Reservation is the external-effect linearization point, under authority.
 * The human identity, main, version and exact active/pending key are rechecked. */
export async function reserveMirrorAttempt(
  query: LockQuery,
  input: { attemptId: string },
): Promise<boolean> {
  const a = (
    await query<{ kbId: string; actorUserId: string }>(
      `SELECT "kbId","actorUserId" FROM kb_mirror_attempt WHERE id=$1::uuid AND state IN ('QUEUED','UNKNOWN')`,
      [input.attemptId],
    )
  ).rows[0];
  if (!a) return false;
  try {
    await authorize({
      store: sqlAuthorityStore(query),
      principal: { kind: "browser", userId: a.actorUserId },
      kbId: a.kbId,
      operation: "manage",
      query,
    });
  } catch {
    return false;
  }
  const result = await query<{ id: string }>(
    `UPDATE kb_mirror_attempt a SET state='RESERVED',"reservedAt"=now(),"finishedAt"=NULL
      FROM kb_remote r, kb_deploy_key_version k, knowledge_base b
      WHERE a.id=$1::uuid AND a.state IN ('QUEUED','UNKNOWN')
        AND b.id=a."kbId" AND b.state='ACTIVE' AND b."headSha"=a."mainSha"
        AND r."kbId"=a."kbId" AND r.state<>'DISCONNECTED'
        AND k."kbId"=a."kbId" AND k.id=a."keyId" AND k.ciphertext IS NOT NULL
        AND ((COALESCE((SELECT desired->>'action' FROM durable_job WHERE id=a.id::text),'PUSH')='PUSH'
          AND r."remoteVersion"=a."remoteVersion" AND r."activeKeyId"=a."keyId" AND k.state='ACTIVE')
         OR ((SELECT desired->>'action' FROM durable_job WHERE id=a.id::text)='ACTIVATE'
          AND r."remoteVersion"+1=a."remoteVersion" AND r."pendingKeyId"=a."keyId" AND k.state='PENDING'))
      RETURNING a.id`,
    [input.attemptId],
  );
  if (result.rows.length !== 1) return false;
  await recordAuditEvent(query, {
    opId: input.attemptId,
    action: "mirror_attempt",
    outcome: "SUCCESS",
    actorKey: actorKeyForUser(a.actorUserId),
    actorUserIdSnapshot: a.actorUserId,
    kbId: a.kbId,
    metadata: { state: "RESERVED" },
  });
  return true;
}

export const mirrorAttemptResultSchema = z.object({
  operationId: z.string().uuid(),
  attemptId: z.string().uuid(),
});
export async function queueMirrorAttempt(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof mirrorMutationInput>,
  action: "PUSH" | "ACTIVATE",
) {
  const input = mirrorMutationInput.parse(raw),
    operation = `MIRROR_${action}_REQUEST`,
    requestHash = canonicalRequestHash(input);
  return asManager(runtime, principal, input.kbId, async (query) => {
    const prior = await findOperationIntent(query, {
      actorKey: actorKeyForUser(principal.userId),
      kbId: input.kbId,
      operation,
      idempotencyKey: input.idempotencyKey,
    });
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
      return mirrorAttemptResultSchema.parse(prior.responseBody);
    }
    await chargeKbMutation(runtime.ratePort, actorKeyForUser(principal.userId), input.kbId);
    const remote = await lockRemote(query, input.kbId),
      keyId = action === "PUSH" ? remote.activeKeyId : remote.pendingKeyId;
    if (!keyId || remote.state === "DISCONNECTED")
      throw new KbDomainError("CONFLICT", "Mirror key unavailable");
    const attemptId = randomUUID();
    await query(
      `INSERT INTO kb_mirror_attempt (id,"kbId","keyId","remoteVersion","actorKey","actorUserId","mainSha")
      SELECT $1::uuid,b.id,k.id,k."remoteVersion",$4,$5,b."headSha" FROM knowledge_base b, kb_deploy_key_version k
      WHERE b.id=$2 AND k."kbId"=b.id AND k.id=$3`,
      [attemptId, input.kbId, keyId, actorKeyForUser(principal.userId), principal.userId],
    );
    await enqueueDurableJobOnQuery(query, {
      jobId: attemptId,
      dedupKey: `mirror:${attemptId}`,
      kind: "PUSH_MIRROR",
      desired: { action },
    });
    const responseBody = { operationId: attemptId, attemptId };
    await recordFinalizedReceipt(query, {
      ...input,
      actorUserId: principal.userId,
      operation,
      requestHash,
      opId: attemptId,
      responseBody,
    });
    await recordAuditEvent(query, {
      opId: attemptId,
      action: operation.toLowerCase(),
      outcome: "SUCCESS",
      actorKey: actorKeyForUser(principal.userId),
      actorUserIdSnapshot: principal.userId,
      kbId: input.kbId,
      metadata: { state: "QUEUED" },
    });
    return responseBody;
  });
}

/** Always called after external group drain, including cancellation and restart.
 * UNKNOWN remains an honest remote outcome; retries must advertise/reconcile first. */
export async function finishMirrorAttempt(
  query: LockQuery,
  input: {
    attemptId: string;
    state: "COMPLETED" | "FAILED" | "UNKNOWN" | "CANCELLED";
    resultCode: string;
    activate?: boolean;
  },
) {
  const a = (
    await query<{ kbId: string; keyId: string; actorUserId: string; state: string }>(
      `SELECT "kbId","keyId","actorUserId",state::text AS state FROM kb_mirror_attempt WHERE id=$1::uuid FOR UPDATE`,
      [input.attemptId],
    )
  ).rows[0];
  if (!a) return;
  if (!["QUEUED", "RESERVED", "UNKNOWN"].includes(a.state)) {
    await destroyDrainedDeployKeys(query, a.kbId);
    return;
  }
  let { state, resultCode } = input;
  if (input.activate && state === "COMPLETED") {
    try {
      await authorize({
        store: sqlAuthorityStore(query),
        principal: { kind: "browser", userId: a.actorUserId },
        kbId: a.kbId,
        operation: "manage",
        query,
      });
      await activateVerifiedDeployKey(query, { kbId: a.kbId, keyId: a.keyId });
    } catch {
      state = "CANCELLED";
      resultCode = "SUPERSEDED";
    }
  }
  await query(
    `UPDATE kb_mirror_attempt SET state=$2::"MirrorAttemptState","resultCode"=$3,"finishedAt"=now() WHERE id=$1::uuid`,
    [input.attemptId, state, resultCode],
  );
  await recordAuditEvent(query, {
    opId: input.attemptId,
    action: "mirror_attempt",
    outcome: "SUCCESS",
    actorKey: actorKeyForUser(a.actorUserId),
    actorUserIdSnapshot: a.actorUserId,
    kbId: a.kbId,
    metadata: { state, reasonCode: resultCode },
  });
  await query(
    `UPDATE audit_event SET metadata=$2::jsonb WHERE "opId"=$1 AND action='mirror_attempt'`,
    [input.attemptId, JSON.stringify({ state, reasonCode: resultCode })],
  );
  await destroyDrainedDeployKeys(query, a.kbId);
}
