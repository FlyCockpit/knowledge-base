# Cockpit host adapter contract

This repository ships reusable `kb-client` seams for remote/local KB attachment,
retrieval, atomic dreams and encrypted sealed resolution. Cockpit's host must
adopt these APIs in its own repository. There is no
separate REST/oRPC adapter, server-side LLM or server dream scheduler.

## Per-KB identity and immutable snapshot_source

A remote locator is `https://kb.example/mcp#kb=<kbId>`, not just the server origin.
Strip the fragment for HTTP/OAuth resource use; retain it for attachment identity.
Local locator is `kb-local://<storeUuid>/<kbId>`. `KbAttachment` returns the locator
and sealed namespace. UUIDv5 uses NAMESPACE_URL and the established name bytes:
`flycockpit/knowledge-attachment/v1\0remote\0` plus canonical locator bytes
(or `local` for a managed-store locator). Two KBs therefore have distinct
namespaces. Display-name changes preserve identity; origin changes require
explicit reattachment and sealed re-enrollment. This does not assert identity
with an arbitrary Cockpit worktree path.

`RemoteKb.retrieve` searches, then `snapshot_source` retrieves
`knowledge_documents_get` at each hit's commit SHA, verifies blob SHA and full
Markdown SHA-256 and checks source spans. It never substitutes current HEAD.
Frontmatter citations/assetRefs come from that immutable commit; snippets are
bounded untrusted model data, not executable instructions. Fixture GET input:

```json kb/1 knowledge_documents_get input
{
  "kbId": "abcdefghijklmnopqrstuvwx",
  "path": "docs/guide.md"
}
```

Supply `rev` from the real hit when requesting an immutable snapshot. The fixture
omits it to demonstrate the default-main schema; snapshot_source always pins it.

## Atomic DreamSink and deferred proposals

`apply_dream(DreamChangeSet)` maps source session UUIDs and ConceptUpsert fields
to ONE `knowledge_changes_apply(mode:"dream")` call. It obtains a baseRevision,
retains one idempotency key across uncertain retries and does not split a batch.
Dream metadata has model provider/name, `redactionApplied:true`, upserts with
id/type/title/body/citations and provenance dream; generic changes must be empty.
Max eight upserts, each body 64 KiB; larger staged edits are ordinary edit calls,
not a DreamSink batch. Source UUIDs/model are provenance, never delegated identity.

Existing IDs retain their paths; new IDs map to deterministic `concepts/<id>.md`.
Non-dream or absent provenance is conservatively human and cannot be overwritten.
No dream deletes/assets/sealed literals. One invalid upsert fails the entire
set without a commit/PR/job. Server applies a credential-pattern floor but the
client owns redaction-before-upload and its private RedactionTable. Merge checks
human provenance again against current main, even for a previously accepted
proposal. A later human edit causes a conflict rather than review bypass.

Wire outcomes are `applied`, `noop` or `proposed`. Applied finalizes Git and metadata.
A noop is a durable receipt with no new commit/PR/job: unchanged main has `proposal:null`;
an unchanged active proposal has a non-null `proposal`.
Use the Rust adapter's `DreamOutcome::advances_consumer_ledger()`: only `Applied` and main `Noop` return true.
`Proposed` and `ProposalNoop` leave main/index unchanged and keep the consumer ledger deferred until merge.
The server records provenance/source digest but does not own the host's episode watermark.
Lost replies require the same actor/key/payload; cancellation is not proof that a reserved publication did not commit.

To continue an existing proposal, construct a new `PreparedDream::new_for_proposal`
with its number and the head SHA you observed, then submit that same prepared
request for every uncertain retry. A PR-head base alone does not grant overwrite
consent. The constructor also supports explicitly named proposal no-ops.

This active proposal fixture maps to `ProposalNoop`, keeping the ledger deferred; compare [MCP](./mcp.md)'s main-noop fixture (`proposal:null`):

```json kb/1 knowledge_changes_apply output
{"baseRevision": "0000000000000000000000000000000000000000", "changedPaths": [],
  "commitSha": "0000000000000000000000000000000000000000",
  "indexJobId": null, "kind": "noop", "operationId": "00000000-0000-4000-8000-000000000001",
  "proposal": {"authorActorKey": "actor:fixture", "baseSha": "0000000000000000000000000000000000000000",
    "headSha": "0000000000000000000000000000000000000000", "mergeCommitSha": null,
    "number": 1, "sourceBranch": "feature/fixture", "status": "OPEN", "targetBranch": "main",
    "targetSha": "0000000000000000000000000000000000000000", "title": "Fixture PR", "version": 1
  }, "sourceSessionIds": []}
```

## Recipient-encrypted RemoteResolver

Reference grammar is
`{{sealed:v1:knowledge_base:<attachment_uuid>:<record_uuid>}}`.
Enrollment and consumer approval are human-only browser/local-owner operations;
enrolled 2FA and current owner authority are required remotely. Owner-set live
share `includeSealedValues` defaults false; only the owner may enable it. OAuth
requests for sealed recipients fail. PAT/CLI approval binds exact records to an
exact live grant generation and registered recipient X25519 public key/expiry.
Manage alone never authorizes sealed literals. No wildcard record enumeration.

`knowledge_sealed_resolve` checks live read, exact namespace/record/key capability,
expiry and reference occurrence in the requested path/reachable immutable rev.
Foreign/missing/revoked references return uniform UNRESOLVED_REFERENCE. The
response is an expiring X25519-HKDF-SHA256-AES256GCM recipient envelope; plaintext
never enters a tool result, snippet, model prompt or log. TTL is at most 60 s.
HKDF salt is SHA-256(reference); info and AES-GCM AAD bind reference, recipient
key ID and expiresAt (see the tested crate's `sealed.rs`).

Only the explicit host resolver decrypts into `SecretLiteral`, a zeroizing
nonserializable wrapper with redacted formatting; agent forwarding projects
ciphertext unchanged. Keep recipient private keys in host custody. Copying a
foreign symbolic token to another KB is rejected: authorized travel explicitly
resolves for the host, enrolls under the destination namespace with a new token
and obtains destination approvals. Origin-change/legacy repair never creates a
namespace bypass. Server/local stores keep symbols; indexes redact them.
