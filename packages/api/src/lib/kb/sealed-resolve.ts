import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { remoteSealedNamespace } from "./attachment";
import { admitSecurityEvent, recordAuditFailure } from "./audit";
import {
  assertSealedReferenceAtRevision,
  authorizeDocumentRead,
  resolvePinnedRevision,
} from "./documents-read";
import { requireKbMasterKey } from "./envelope";
import { KbDomainError } from "./errors";
import { assertGitReadActive, kbBareRepoPath } from "./git-read";
import type { LockQuery } from "./lock";
import { sqlAuthorityStore } from "./permissions";
import {
  actorKeyFor,
  type CredentialVerifier,
  type Principal,
  type TokenAdmission,
  type TokenPrincipal,
} from "./principal";
import { kbReadToolSchemas } from "./protocol/reads";
import type { KbRuntimeConfig } from "./runtime";
import { createRecipientEnvelope } from "./sealed-envelope";
import { decryptSealedRecord, loadSealedResolution } from "./sealed-records";
import { parseSealedReference } from "./sealed-reference";

/** Trusted credential adapter supplies the kind; consumerId is ALWAYS principal.grantId.
 * OAuth/PAT registry wiring lands with authentication, never as caller-controlled tool fields. */
export type SealedCredentialVerifier = Pick<CredentialVerifier, "grantBits"> & {
  inspect(principal: TokenPrincipal): Promise<TokenAdmission & { consumerKind: "pat" | "oauth" }>;
};
type Runtime = Pick<KbRuntimeConfig, "canonicalOrigin" | "reposDir" | "coordinator">;
type Options = {
  verifier: SealedCredentialVerifier;
  masterKey: string | undefined;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Test/transport barrier before acquiring final authority; no secret exists here. */
  beforeFinalRead?: () => Promise<void>;
};
const schema = kbReadToolSchemas.knowledge_sealed_resolve;
const unresolved = () => new KbDomainError("UNRESOLVED_REFERENCE", "Unresolved reference");

/** Read-only service. The only returned value is the closed recipient ciphertext envelope.
 * Lock order: authority -> SQL transaction, released during immutable Git I/O, then reacquired
 * for live reauthorization+wrapping. No plaintext survives a synchronous frame or any await. */
export async function resolveSealedReference(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof schema.input>,
  options: Options,
): Promise<z.infer<typeof schema.output>> {
  const parsed = schema.input.safeParse(raw);
  if (!parsed.success) throw new KbDomainError("INVALID_ARGUMENT", "Invalid argument");
  const input = parsed.data;
  const deadline = Math.min(options.deadlineAt ?? Infinity, Date.now() + 60_000);
  const readOptions = { signal: options.signal, deadlineAt: deadline };
  const active = () => assertGitReadActive(readOptions);
  try {
    active();
    if (principal.kind !== "token") throw unresolved();
    const identity = parseSealedReference(input.reference);
    if (identity.namespace !== remoteSealedNamespace(runtime.canonicalOrigin, input.kbId))
      throw unresolved();
    const locked = <T>(run: (query: LockQuery) => Promise<T>) =>
      runtime.coordinator.run({
        opId: randomUUID(),
        kind: "authority",
        run: ({ lease, signal }) =>
          lease.transaction(async (query) => {
            active();
            if (signal.aborted) throw unresolved();
            const result = await run(query);
            active();
            if (signal.aborted) throw unresolved();
            return result;
          }),
      });
    const authority = async (query: LockQuery) => {
      // One fresh inspection feeds both admission and consumer-kind binding for this read.
      const admission = await options.verifier.inspect(principal);
      await authorizeDocumentRead({
        principal,
        kbId: input.kbId,
        operation: "read",
        store: sqlAuthorityStore(query),
        verifier: { ...options.verifier, inspect: async () => admission },
      });
      // Only PAT credentials (human-minted or CLI device flow) hold
      // sealed-recipient capabilities; an OAuth credential never resolves.
      if (
        (principal.expiresAt !== null && principal.expiresAt.getTime() <= Date.now()) ||
        admission.consumerKind !== "pat"
      )
        throw unresolved();
      const row = await loadSealedResolution(query, {
        kbId: input.kbId,
        ...identity,
        consumerKind: "pat",
        consumerId: principal.grantId,
        recipientKeyId: input.recipientKeyId,
        userId: principal.userId,
      });
      active();
      return row;
    };
    const head = await locked(async (query) => {
      await authority(query);
      const result = await query<{ headSha: string | null }>(
        `SELECT "headSha" FROM "knowledge_base" WHERE id=$1`,
        [input.kbId],
      );
      return result.rows[0]?.headSha ?? null;
    });
    const commitSha = await resolvePinnedRevision(
      kbBareRepoPath(runtime.reposDir, input.kbId),
      input.rev,
      head,
      readOptions,
    );
    await assertSealedReferenceAtRevision({
      ...readOptions,
      reposDir: runtime.reposDir,
      kbId: input.kbId,
      commitSha,
      path: input.path,
      reference: input.reference,
    });
    active();
    await options.beforeFinalRead?.();
    const result = await locked(async (query) => {
      const row = await authority(query);
      // The grant may have expired while an awaited identity/SQL read completed.
      const now = Date.now();
      const expires = Math.min(
        now + 60_000,
        row.expiresAt.getTime(),
        principal.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
      );
      if (expires <= now) throw unresolved();
      const master = requireKbMasterKey(options.masterKey);
      try {
        const literal = decryptSealedRecord(
          row.ciphertext,
          { ...identity, version: row.version },
          master,
        );
        try {
          return createRecipientEnvelope(literal, {
            ...input,
            recipientPublicKey: row.recipientPublicKey,
            expiresAt: new Date(expires).toISOString(),
          });
        } finally {
          literal.destroy();
        }
      } finally {
        master.fill(0);
      }
    });
    active();
    if (Date.parse(result.expiresAt) <= Date.now()) throw unresolved();
    return result;
  } catch (error) {
    if (
      error instanceof KbDomainError &&
      (error.code === "CANCELLED" || error.code === "DEADLINE_EXCEEDED")
    )
      throw error;
    // Absent, foreign, ungranted, revoked, unreachable and decrypt failures share one code/body.
    await recordResolveDenial(runtime, principal);
    throw unresolved();
  }
}

/** Best effort: a failed audit write never changes the uniform denial the caller sees. */
async function recordResolveDenial(runtime: Runtime, principal: Principal): Promise<void> {
  const actorKey = actorKeyFor(principal);
  if (!admitSecurityEvent(actorKey)) return;
  try {
    await runtime.coordinator.run({
      opId: randomUUID(),
      kind: "authority",
      run: ({ lease }) =>
        lease.transaction((query) =>
          recordAuditFailure(query, {
            action: "sealed_resolve_denied",
            actorKey,
            actorUserIdSnapshot: principal.userId,
            actorUserId: principal.userId,
            grantIdSnapshot: principal.kind === "token" ? principal.grantId : null,
            metadata: { reasonCode: "UNRESOLVED_REFERENCE" },
          }),
        ),
    });
  } catch {
    /* audit is best effort for denials */
  }
}
