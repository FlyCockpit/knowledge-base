-- kb-local durable store schema, version 1.
--
-- This is the ONLY durable schema file. The project is unreleased: later local chunks
-- extend this file in place (same user_version) instead of appending a
-- migration. `state.sqlite` is NOT disposable — it holds the store identity,
-- the KB registry, local authority and the operation journal. Derived index
-- files under `indexes/` are disposable and are never referenced by anything
-- that cannot be rebuilt from Git.
--
-- Applied once, inside one transaction, by the process that initializes an
-- empty store under the store lock. `PRAGMA user_version = 1` is set by the
-- initializer in the same transaction.

-- Singleton store identity. `id = 1` enforces a single row.
CREATE TABLE store_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  store_uuid TEXT NOT NULL CHECK (length(store_uuid) = 36),
  -- Opaque local owner principal (random, never derived from OS user names).
  owner_principal_id TEXT NOT NULL UNIQUE CHECK (length(owner_principal_id) = 36),
  -- HMAC-SHA256 key for opaque page cursors (random, never exported). The
  -- store root is owner-only, so this row is owner-only durable state.
  cursor_key BLOB NOT NULL CHECK (length(cursor_key) = 32),
  sealed_key_ready INTEGER NOT NULL DEFAULT 0 CHECK(sealed_key_ready IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;

-- KB registry. IDs are lowercase cuid2-style (24..32 [a-z0-9]) and are the
-- only input to managed paths (`repos/kb_<id>.git`, `indexes/<id>/...`).
CREATE TABLE kbs (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 24 AND 32 AND id NOT GLOB '*[^a-z0-9]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Unique among live KBs only (`kbs_live_slug`); a tombstone keeps its
  -- slug and history while releasing it for reuse.
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 63),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 2000),
  state TEXT NOT NULL
    CHECK (state IN ('CREATING', 'ACTIVE', 'TOMBSTONED', 'REPAIR_REQUIRED')),
  head_sha TEXT CHECK (head_sha IS NULL OR (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*')),
  metadata_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_version >= 1),
  desired_epoch INTEGER NOT NULL DEFAULT 0 CHECK (desired_epoch >= 0),
  sealed_policy_generation INTEGER NOT NULL DEFAULT 0 CHECK (sealed_policy_generation >= 0),
  -- Next proposal number of this KB (per-KB allocation, never reused). A
  -- finalize that opens proposal N moves it from N to N + 1 (CAS), so an
  -- aborted reservation burns no number.
  next_pr_number INTEGER NOT NULL DEFAULT 1 CHECK (next_pr_number >= 1),
  active_generation_id TEXT,
  desired_generation_id TEXT,
  profile_json TEXT CHECK(profile_json IS NULL OR json_valid(profile_json)),
  -- Set when the active index file was lost; cleared by the next build.
  index_rebuild_required INTEGER NOT NULL DEFAULT 0 CHECK (index_rebuild_required IN (0, 1)),
  -- L-22: a tombstoned KB's repository and indexes were deleted; the row and
  -- its receipts stay. Cleanup revisits only if maintenance residue remains.
  data_purged INTEGER NOT NULL DEFAULT 0 CHECK (data_purged IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (state <> 'ACTIVE' OR head_sha IS NOT NULL),
  FOREIGN KEY (id, active_generation_id) REFERENCES index_generations (kb_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, desired_generation_id) REFERENCES index_generations(kb_id,id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX kbs_live_slug ON kbs (slug) WHERE state <> 'TOMBSTONED';
CREATE INDEX kbs_purge_pending ON kbs (id) WHERE state = 'TOMBSTONED' AND data_purged = 0;

-- Index generation registry. The generation's SQLite file lives at
-- `indexes/<kb_id>/<id>.sqlite`; the row is durable, the file is not.
CREATE TABLE index_generations (
  id TEXT NOT NULL
    CHECK (length(id) BETWEEN 24 AND 32 AND id NOT GLOB '*[^a-z0-9]*'),
  kb_id TEXT NOT NULL REFERENCES kbs (id) ON DELETE RESTRICT,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  state TEXT NOT NULL
    CHECK (state IN ('PENDING', 'BUILDING', 'INDEXING', 'COMPLETE', 'FAILED', 'SUPERSEDED')),
  created_at TEXT NOT NULL,
  commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  job_id TEXT NOT NULL UNIQUE CHECK(length(job_id)=36),
  attempt TEXT,
  attempt_until_ms INTEGER NOT NULL DEFAULT 0,
  -- Outstanding capacity minus measured file bytes is promised disk headroom.
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  allocated_bytes INTEGER NOT NULL DEFAULT 0 CHECK(allocated_bytes>=0),
  finished_ms INTEGER,
  error_code TEXT,
  reclaimed INTEGER NOT NULL DEFAULT 0 CHECK(reclaimed IN (0,1)),
  -- Authoritative build accounting, written with COMPLETE; every open of the
  -- index file requires its meta row to match both counts exactly.
  document_count INTEGER CHECK(document_count IS NULL OR document_count>=0),
  chunk_count INTEGER CHECK(chunk_count IS NULL OR chunk_count>=0),
  CHECK((document_count IS NULL)=(chunk_count IS NULL)),
  CHECK(state<>'COMPLETE' OR chunk_count IS NOT NULL),
  PRIMARY KEY (kb_id, id),
  UNIQUE(kb_id,epoch),
  UNIQUE (id)
) STRICT;

CREATE INDEX generation_reserved ON index_generations(kb_id,reserved_bytes,allocated_bytes) WHERE reserved_bytes>0;

-- Immutable desired snapshot; attempts and runtime state are separate fences.
CREATE TRIGGER generation_snapshot_immutable BEFORE UPDATE ON index_generations
WHEN NEW.id<>OLD.id OR NEW.kb_id<>OLD.kb_id OR NEW.epoch<>OLD.epoch
  OR NEW.commit_sha<>OLD.commit_sha OR NEW.snapshot_json<>OLD.snapshot_json OR NEW.job_id<>OLD.job_id
BEGIN SELECT RAISE(ABORT,'generation snapshot is immutable'); END;
CREATE TABLE index_jobs (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  generation_id TEXT NOT NULL UNIQUE REFERENCES index_generations(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','COMPLETE','FAILED','CANCELLED'))
) STRICT;
CREATE TABLE index_receipts (
  actor_key TEXT NOT NULL, kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('PROFILE_SET','INDEX_REBUILD')),
  idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY(actor_key,kb_id,operation,idempotency_key)
) STRICT;
CREATE TABLE generation_leases (
  id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES index_generations(id) ON DELETE RESTRICT,
  expires_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX generation_lease_expiry ON generation_leases(generation_id,expires_ms);
-- Shared search/structured 30/minute user+KB admission; actor_key is the
-- single store owner's identity, distinct from the authorization principal.
CREATE TABLE query_charges (
  id TEXT PRIMARY KEY, actor_key TEXT NOT NULL, kb_id TEXT NOT NULL REFERENCES kbs(id), created_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX query_charge_window ON query_charges(actor_key,kb_id,created_ms);
CREATE TABLE index_events (
  id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES index_generations(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('profile_set','index_rebuild','generation_activate','generation_fail'))
) STRICT;

-- Local authority. The owner holds every bit implicitly; rows here are
-- capability ceilings for narrowed config/test principals (never widening).
-- Bits: read=1 propose=2 write=4 review=8 manage=16 (stored unexpanded).
CREATE TABLE principal_ceilings (
  principal_id TEXT NOT NULL CHECK (length(principal_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('CONFIG', 'TEST')),
  kb_id TEXT NOT NULL REFERENCES kbs (id) ON DELETE RESTRICT,
  bits INTEGER NOT NULL CHECK (bits BETWEEN 0 AND 31),
  PRIMARY KEY (principal_id, kb_id)
) STRICT;

-- Create capability of a narrowed CONFIG/TEST principal (the local
-- equivalent of a PAT's allowCreate + createdKbBits). Creating a KB appends
-- exactly `created_kb_bits` as that principal's ceiling on the new KB, in the
-- KB_CREATE finalize transaction; it never widens anything else. The owner
-- needs no row (every bit on every live KB). Bits must include read.
CREATE TABLE create_capabilities (
  principal_id TEXT PRIMARY KEY CHECK (length(principal_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('CONFIG', 'TEST')),
  created_kb_bits INTEGER NOT NULL
    CHECK (created_kb_bits BETWEEN 1 AND 31 AND (created_kb_bits & 1) = 1),
  created_at TEXT NOT NULL
) STRICT;

-- One-ref publication journal for the local store. One row per
-- logical operation keyed by a nonnull actor + KB + operation + key. Phases:
--   PREPARED    reserved; objects may be under construction. Once
--               `intended_new` is set the row carries the complete typed
--               metadata delta and replay response. CAS never started.
--   COMMITTING  objects are fsynced and authority rechecked under the locks;
--               the single expected-old ref CAS may or may not have run.
--   FINALIZED   ref == intended_new and the delta was applied, in one
--               transaction with this phase change.
--   ABORTED     nothing was published; `failure_code` is the stable failure
--               every retry with the same key receives.
-- KB_UPDATE / KB_DELETE / PR_CREATE / PR_CLOSE are metadata-only receipts: no ref moves, so the row
-- is written FINALIZED in the same transaction as the registry change.
-- CHANGES_APPLY / DOCUMENT_* move main OR one proposal ref; the
-- PREPARED row is inserted only after upfront validation and the whole-tree
-- validator accepted the built commit, carrying intended SHA, delta and the
-- exact ApplyResult replay response. A noop is a FINALIZED receipt with no
-- intended SHA.
-- Recovery (under the store lock): COMMITTING with ref == intended_new
-- finalizes the persisted delta once; ref == expected_old aborts; any third
-- SHA leaves the row and marks the KB REPAIR_REQUIRED (no reset/adopt).
-- PR_MERGE persists the terminal PR delta with the main/desired-epoch delta;
-- recovery commits all of them once. Source branches are retained unchanged.
-- Compaction drops only `delta_json`; the key, request hash, phase, failure
-- and response stay forever, so mismatch detection never expires.
CREATE TABLE operation_intents (
  op_id TEXT PRIMARY KEY CHECK (length(op_id) = 36),
  actor_key TEXT NOT NULL CHECK (length(actor_key) > 0),
  kb_id TEXT NOT NULL REFERENCES kbs (id) ON DELETE RESTRICT,
  operation TEXT NOT NULL
    CHECK (operation IN ('KB_CREATE', 'COMMIT', 'KB_UPDATE', 'KB_DELETE', 'CHANGES_APPLY',
                         'DOCUMENT_CREATE', 'DOCUMENT_UPDATE', 'DOCUMENT_DELETE',
                         'PR_CREATE', 'PR_CLOSE', 'PR_MERGE', 'ASSET_PUT', 'ASSET_IMPORT')),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  phase TEXT NOT NULL CHECK (phase IN ('PREPARED', 'COMMITTING', 'FINALIZED', 'ABORTED')),
  -- The single ref this operation may move: main, or a server-owned
  -- proposal branch `refs/heads/pr/<number>` (change sets only).
  ref_name TEXT NOT NULL DEFAULT 'refs/heads/main' CHECK (
    ref_name = 'refs/heads/main'
    OR (operation IN ('CHANGES_APPLY', 'DOCUMENT_CREATE', 'DOCUMENT_UPDATE', 'DOCUMENT_DELETE', 'ASSET_PUT', 'ASSET_IMPORT')
        AND ref_name GLOB 'refs/heads/*' AND length(ref_name) <= 267)
  ),
  -- NULL = the ref must not exist yet (KB_CREATE, a newly opened proposal).
  expected_old TEXT
    CHECK (expected_old IS NULL OR (length(expected_old) = 40 AND expected_old NOT GLOB '*[^0-9a-f]*')),
  intended_new TEXT
    CHECK (intended_new IS NULL OR (length(intended_new) = 40 AND intended_new NOT GLOB '*[^0-9a-f]*')),
  -- Root tree the whole-tree validator accepted for `intended_new`.
  validated_tree TEXT
    CHECK (validated_tree IS NULL OR (length(validated_tree) = 40 AND validated_tree NOT GLOB '*[^0-9a-f]*')),
  delta_json TEXT,
  response_json TEXT,
  failure_code TEXT,
  -- A typed refusal an ABORTED reviewed merge replays with its key (
  -- PROPOSAL_CONFLICT details, bounded by the protocol's path/content caps).
  failure_details TEXT CHECK (failure_details IS NULL
    OR (phase = 'ABORTED' AND operation = 'PR_MERGE' AND json_valid(failure_details))),
  -- Dream change sets: informational model/source metadata and digests
  -- (never delegated identity, never raw episode content).
  dream_json TEXT CHECK (dream_json IS NULL
    OR (operation = 'CHANGES_APPLY' AND json_valid(dream_json))),
  compacted INTEGER NOT NULL DEFAULT 0 CHECK (compacted IN (0, 1)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (actor_key, kb_id, operation, idempotency_key),
  CHECK (phase <> 'COMMITTING'
    OR (intended_new IS NOT NULL AND validated_tree IS NOT NULL AND delta_json IS NOT NULL
        AND response_json IS NOT NULL)),
  CHECK (phase <> 'FINALIZED' OR response_json IS NOT NULL),
  -- KB_CREATE / COMMIT always publish; change sets publish or are a noop
  -- receipt (FINALIZED, no intended ref value, no delta).
  CHECK (phase <> 'FINALIZED' OR operation NOT IN ('KB_CREATE', 'COMMIT')
    OR intended_new IS NOT NULL),
  CHECK (operation NOT IN ('KB_UPDATE', 'KB_DELETE', 'PR_CREATE', 'PR_CLOSE')
    OR (phase = 'FINALIZED' AND intended_new IS NULL)),
  CHECK (phase <> 'ABORTED' OR failure_code IS NOT NULL),
  CHECK (compacted = 0 OR (phase IN ('FINALIZED', 'ABORTED') AND delta_json IS NULL)),
  CHECK ((phase IN ('FINALIZED', 'ABORTED')) = (finished_at IS NOT NULL))
) STRICT;

-- KB_CREATE retries must find their reserved KB before another ID is
-- allocated: the actor + key is unique across KBs for that operation.
CREATE UNIQUE INDEX operation_intents_kb_create_key
  ON operation_intents (actor_key, operation, idempotency_key)
  WHERE operation = 'KB_CREATE';

-- The per-hour creation window counts recent reservations.
CREATE INDEX operation_intents_created ON operation_intents (operation, created_at);

-- Recovery scans only unresolved rows.
CREATE INDEX operation_intents_pending
  ON operation_intents (kb_id, phase)
  WHERE phase IN ('PREPARED', 'COMMITTING');

-- Owner of every non-main branch ("BranchOwner"). Only its owning
-- actor may append; review/manage never impersonate ownership. Rows are
-- immutable and never deleted (closed/merged branches stay reachable).
CREATE TABLE branch_owners (
  kb_id TEXT NOT NULL REFERENCES kbs (id) ON DELETE RESTRICT,
  ref_name TEXT NOT NULL CHECK (
    (purpose = 'AUTO_PR' AND ref_name GLOB 'refs/heads/pr/[1-9]*'
     AND substr(ref_name, 15) NOT GLOB '*[^0-9]*' AND length(ref_name) <= 30)
    OR (purpose = 'USER' AND ref_name GLOB 'refs/heads/*'
        AND ref_name <> 'refs/heads/main' AND ref_name NOT GLOB 'refs/heads/pr/*'
        AND length(ref_name) <= 267)
  ),
  owner_actor_key TEXT NOT NULL CHECK (length(owner_actor_key) > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('AUTO_PR', 'USER')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (kb_id, ref_name),
  UNIQUE (kb_id, ref_name, owner_actor_key)
) STRICT;

CREATE TRIGGER branch_owners_immutable BEFORE UPDATE ON branch_owners
BEGIN
  SELECT RAISE(ABORT, 'branch ownership is immutable');
END;

CREATE TRIGGER branch_owners_retained BEFORE DELETE ON branch_owners
BEGIN
  SELECT RAISE(ABORT, 'branch ownership is retained');
END;

-- Proposals (kb/1 PrSummary). Numbers are allocated per KB from
-- `kbs.next_pr_number`. The source branch belongs to the author (composite
-- foreign key: the PR author IS the branch owner). One active (OPEN or
-- CONFLICT) auto-PR per actor + KB. CLOSED/MERGED rows are immutable.
CREATE TABLE pull_requests (
  kb_id TEXT NOT NULL REFERENCES kbs (id) ON DELETE RESTRICT,
  number INTEGER NOT NULL CHECK (number >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  source_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
  target_sha TEXT NOT NULL CHECK (length(target_sha) = 40 AND target_sha NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CONFLICT', 'CLOSED', 'MERGED')),
  author_actor_key TEXT NOT NULL,
  is_auto_pr INTEGER NOT NULL CHECK (is_auto_pr IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  merge_commit_sha TEXT
    CHECK (merge_commit_sha IS NULL
      OR (length(merge_commit_sha) = 40 AND merge_commit_sha NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A proposed dream's metadata + merge-guard input (guardTouchedPaths):
  -- the reviewed merge re-checks provenance against current main with it.
  dream_metadata TEXT CHECK (dream_metadata IS NULL OR json_valid(dream_metadata)),
  -- The main the stored OPEN/CONFLICT was computed against (NULL =
  -- unchecked), and the conflicts a move onto main recorded and the PR has
  -- not resolved yet (JSON array of {path, kind, standing?, baseSha?, yoursSha?}).
  merge_checked_key TEXT,
  merge_checked_sha TEXT
    CHECK (merge_checked_sha IS NULL
      OR (length(merge_checked_sha) = 40 AND merge_checked_sha NOT GLOB '*[^0-9a-f]*')),
  pending_conflicts TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(pending_conflicts) AND json_type(pending_conflicts) = 'array'),
  PRIMARY KEY (kb_id, number),
  UNIQUE (kb_id, source_ref),
  CHECK (source_ref = 'refs/heads/pr/' || number OR is_auto_pr = 0),
  CHECK ((status = 'MERGED') = (merge_commit_sha IS NOT NULL)),
  FOREIGN KEY (kb_id, source_ref, author_actor_key)
    REFERENCES branch_owners (kb_id, ref_name, owner_actor_key)
) STRICT;

CREATE UNIQUE INDEX pull_requests_active_source
  ON pull_requests (kb_id, source_ref) WHERE status IN ('OPEN', 'CONFLICT');

CREATE UNIQUE INDEX pull_requests_active_auto
  ON pull_requests (kb_id, author_actor_key)
  WHERE is_auto_pr = 1 AND status IN ('OPEN', 'CONFLICT');

CREATE TRIGGER pull_requests_terminal_immutable BEFORE UPDATE ON pull_requests
WHEN OLD.status IN ('CLOSED', 'MERGED')
BEGIN
  SELECT RAISE(ABORT, 'closed or merged proposal is immutable');
END;

CREATE TRIGGER pull_requests_identity_immutable BEFORE UPDATE ON pull_requests
WHEN NEW.kb_id <> OLD.kb_id OR NEW.number <> OLD.number OR NEW.source_ref <> OLD.source_ref
  OR NEW.author_actor_key <> OLD.author_actor_key OR NEW.is_auto_pr <> OLD.is_auto_pr
BEGIN
  SELECT RAISE(ABORT, 'proposal identity is immutable');
END;

CREATE TRIGGER pull_requests_dream_retained BEFORE UPDATE ON pull_requests
WHEN OLD.dream_metadata IS NOT NULL AND NEW.dream_metadata IS NULL
BEGIN
  SELECT RAISE(ABORT, 'proposal dream metadata is retained');
END;

CREATE TRIGGER pull_requests_retained BEFORE DELETE ON pull_requests
BEGIN
  SELECT RAISE(ABORT, 'proposals are retained');
END;

-- Begin receipt and reservation precede staging I/O. Pending frame intent
-- survives partial writes; offset follows fsync; expiry releases once before
-- unlink and records successful reclamation. Rows/key bindings are retained.
CREATE TABLE staged_uploads (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  op_id TEXT NOT NULL UNIQUE CHECK (length(op_id)=36),
  kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  kind TEXT NOT NULL CHECK (kind IN ('markdown','asset')),
  size INTEGER NOT NULL CHECK (size>=0 AND size<=CASE kind WHEN 'markdown' THEN 2097152 ELSE 26214400 END),
  hash TEXT NOT NULL CHECK (length(hash)=71 AND substr(hash,1,7)='sha256:'),
  mime TEXT NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0 CHECK (offset BETWEEN 0 AND size),
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'WRITING' CHECK (state IN ('WRITING','READY','EXPIRED','CONSUMED')),
  reserved_by_op_id TEXT REFERENCES operation_intents(op_id) ON DELETE RESTRICT,
  consumed_by_op_id TEXT REFERENCES operation_intents(op_id) ON DELETE RESTRICT,
  reserved INTEGER NOT NULL DEFAULT 1 CHECK (reserved IN (0,1)),
  reclaimed INTEGER NOT NULL DEFAULT 0 CHECK (reclaimed IN (0,1)),
  retry_ms INTEGER NOT NULL DEFAULT 0,
  pending_size INTEGER CHECK (pending_size BETWEEN 1 AND 196608 AND offset+pending_size<=size),
  pending_hash TEXT,
  poisoned INTEGER NOT NULL DEFAULT 0 CHECK (poisoned IN (0,1)),
  UNIQUE (actor_key,kb_id,idempotency_key),
  CHECK ((pending_size IS NULL)=(pending_hash IS NULL)),
  CHECK ((state IN ('EXPIRED','CONSUMED'))=(reserved=0)),
  CHECK ((state='CONSUMED')=(consumed_by_op_id IS NOT NULL)),
  CHECK (reserved_by_op_id IS NULL OR state='READY'),
  CHECK (state<>'READY' OR (offset=size AND pending_size IS NULL AND poisoned=0))
) STRICT;
CREATE INDEX staged_uploads_expiry ON staged_uploads(expires_ms,id) WHERE state IN ('WRITING','READY') AND reserved_by_op_id IS NULL;
CREATE INDEX staged_uploads_cleanup ON staged_uploads(retry_ms,id) WHERE state IN ('EXPIRED','CONSUMED') AND reclaimed=0;
CREATE INDEX staged_uploads_hour ON staged_uploads(created_ms,size);
CREATE INDEX staged_uploads_reserved ON staged_uploads(kb_id,size) WHERE reserved=1;
CREATE TABLE mutation_windows (
  actor_key TEXT NOT NULL,
  kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  times_json TEXT NOT NULL CHECK (json_valid(times_json) AND json_type(times_json)='array' AND json_array_length(times_json)<=600),
  PRIMARY KEY(actor_key,kb_id)
) STRICT;

-- Trusted metadata and permanent recipient lineage, written only by journal
-- finalize. HEAD removal, staging expiry and source revoke never delete them.
CREATE TABLE asset_blobs (
  hash TEXT PRIMARY KEY CHECK (length(hash)=71 AND substr(hash,1,7)='sha256:' AND substr(hash,8) NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm','audio/mpeg','audio/wav','audio/ogg','application/pdf')),
  verified_at TEXT NOT NULL
) STRICT;
CREATE TABLE kb_asset_lineage (
  kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  hash TEXT NOT NULL REFERENCES asset_blobs(hash) ON DELETE RESTRICT,
  actor_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('UPLOAD','IMPORT')),
  source_kb_id TEXT REFERENCES kbs(id) ON DELETE RESTRICT,
  source_rev TEXT CHECK (source_rev IS NULL OR (length(source_rev)=40 AND source_rev NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY(kb_id,hash),
  CHECK ((source='IMPORT')=(source_kb_id IS NOT NULL AND source_rev IS NOT NULL)),
  CHECK (source<>'UPLOAD' OR (source_kb_id IS NULL AND source_rev IS NULL))
) STRICT;
CREATE TRIGGER kb_asset_lineage_retained BEFORE DELETE ON kb_asset_lineage
BEGIN SELECT RAISE(ABORT,'asset lineage is retained'); END;
CREATE TRIGGER kb_asset_lineage_immutable BEFORE UPDATE ON kb_asset_lineage
BEGIN SELECT RAISE(ABORT,'asset lineage is immutable'); END;

-- Export receipts are retained after artifact reclamation. WRITING owns the
-- private UUID artifact; READY owns a slot until acknowledgement/expiry.
CREATE TABLE export_artifacts (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  rev TEXT NOT NULL CHECK (length(rev)=40 AND rev NOT GLOB '*[^0-9a-f]*'),
  expires_ms INTEGER NOT NULL,
  completed_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN ('WRITING','READY','ABORTED','DOWNLOADED')),
  size INTEGER CHECK (size BETWEEN 22 AND 277577750),
  offset INTEGER NOT NULL DEFAULT 0 CHECK (offset>=0 AND (size IS NULL OR offset<=size)),
  content_hash TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  failure_code TEXT,
  reclaimed INTEGER NOT NULL DEFAULT 0 CHECK (reclaimed IN (0,1)),
  retry_ms INTEGER NOT NULL DEFAULT 0,
  UNIQUE(actor_key,kb_id,idempotency_key),
  CHECK (state<>'READY' OR (size IS NOT NULL AND content_hash IS NOT NULL AND response_json IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX export_actor_slot ON export_artifacts(actor_key) WHERE state IN ('WRITING','READY');
CREATE INDEX export_active ON export_artifacts(state,expires_ms) WHERE state IN ('WRITING','READY');
CREATE INDEX export_cleanup ON export_artifacts(retry_ms,id) WHERE state IN ('ABORTED','DOWNLOADED') AND reclaimed=0;
CREATE TABLE export_frames (
  export_id TEXT NOT NULL REFERENCES export_artifacts(id) ON DELETE RESTRICT,
  frame INTEGER NOT NULL CHECK (frame BETWEEN 0 AND 1411),
  hash TEXT NOT NULL CHECK (length(hash)=71 AND substr(hash,1,7)='sha256:'),
  PRIMARY KEY(export_id,frame)
) STRICT;

-- Human-only provider control metadata; credential bytes NEVER enter SQLite.
CREATE TABLE provider_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  allow_loopback INTEGER NOT NULL DEFAULT 0 CHECK(allow_loopback IN (0,1))
) STRICT;
INSERT INTO provider_settings(id) VALUES(1);
CREATE TABLE providers (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 24 AND 32 AND id NOT GLOB '*[^a-z0-9]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
) STRICT;
CREATE TRIGGER providers_revocation_terminal BEFORE UPDATE ON providers
WHEN NEW.id<>OLD.id OR NEW.name<>OLD.name OR NEW.revoked<OLD.revoked
BEGIN SELECT RAISE(ABORT,'provider identity and revocation are immutable'); END;
CREATE TABLE provider_revisions (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  endpoint_url TEXT NOT NULL CHECK(length(endpoint_url)<=2048),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
  dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 2000),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=71 AND substr(fingerprint,1,7)='sha256:'),
  state TEXT NOT NULL CHECK(state IN ('STORING','REGISTERED','PROBING','READY','FAILED','REVOKED')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
  probe_until_ms INTEGER NOT NULL DEFAULT 0,
  secret_deleted INTEGER NOT NULL DEFAULT 0 CHECK(secret_deleted IN (0,1)),
  PRIMARY KEY(provider_id,revision)
) STRICT;
CREATE TRIGGER provider_revision_immutable BEFORE UPDATE ON provider_revisions
WHEN NEW.provider_id<>OLD.provider_id OR NEW.revision<>OLD.revision
  OR NEW.endpoint_url<>OLD.endpoint_url OR NEW.model<>OLD.model
  OR NEW.dimensions<>OLD.dimensions OR NEW.fingerprint<>OLD.fingerprint
  OR NEW.attempt<OLD.attempt OR NEW.secret_deleted<OLD.secret_deleted
  OR (OLD.state='REVOKED' AND NEW.state<>'REVOKED')
BEGIN SELECT RAISE(ABORT,'provider revision is immutable'); END;
CREATE TRIGGER provider_revision_retained BEFORE DELETE ON provider_revisions
BEGIN SELECT RAISE(ABORT,'provider revisions are retained'); END;
CREATE TABLE provider_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('provider_create','provider_probe','provider_revoke','provider_loopback')),
  provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
  revision INTEGER,
  created_ms INTEGER NOT NULL
) STRICT;

-- Charged admission survives failures, other handles and restart.
CREATE TABLE provider_probe_charges (id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL) STRICT;
CREATE INDEX provider_probe_window ON provider_probe_charges(created_ms);

-- Owner/key/request-bound receipt; secret binding is a purpose-separated keyed MAC.
CREATE TABLE provider_registrations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_mac BLOB NOT NULL CHECK(length(request_mac)=32),
  provider_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  UNIQUE(provider_id,revision),
  FOREIGN KEY(provider_id,revision) REFERENCES provider_revisions(provider_id,revision) ON DELETE RESTRICT
) STRICT;

-- One optional active built-in; disabling persists its fence before native drain.
CREATE TABLE builtin_model (
  id INTEGER PRIMARY KEY CHECK(id=1),
  model_id TEXT NOT NULL DEFAULT 'embeddinggemma-2-q8_0',
  context_tokens INTEGER NOT NULL DEFAULT 1024 CHECK(context_tokens IN (1024,2048,4096,8192)),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  reloading INTEGER NOT NULL DEFAULT 0 CHECK(reloading IN (0,1)),
  slot INTEGER NOT NULL DEFAULT 0 CHECK(slot IN (0,1))
) STRICT;
INSERT INTO builtin_model(id) VALUES(1);
CREATE TABLE model_events (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('model_enable','model_disable','model_download','model_probe','model_probe_failed'))
) STRICT;

-- Active fields always retain the last good config. Intent precedes native IO.
-- The configuration lease drains abandoned probe children before recovery.
CREATE TABLE model_probe (
  id INTEGER PRIMARY KEY CHECK(id=1),
  attempt TEXT NOT NULL,
  base_epoch INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  context_tokens INTEGER NOT NULL CHECK(context_tokens IN (1024,2048,4096,8192)),
  slot INTEGER NOT NULL CHECK(slot IN (0,1))
) STRICT;

-- Human sealed control. The store random32-byte key exists ONLY in the OS keystore.
-- The initial store key slot precedes native writes; enrollment commits ciphertext,
-- receipt and audit atomically. Revoked identity cannot be reused.
CREATE TRIGGER sealed_key_terminal BEFORE UPDATE OF sealed_key_ready ON store_meta
WHEN NEW.sealed_key_ready<OLD.sealed_key_ready
BEGIN SELECT RAISE(ABORT,'sealed key is never regenerated'); END;
CREATE TABLE sealed_records (
  namespace TEXT NOT NULL CHECK(length(namespace)=36),
  record_id TEXT NOT NULL CHECK(length(record_id)=36),
  kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version=1),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
  nonce BLOB,
  ciphertext BLOB,
  PRIMARY KEY(namespace,record_id),
  CHECK((state='ACTIVE' AND nonce IS NOT NULL AND ciphertext IS NOT NULL
    AND length(nonce)=12 AND length(ciphertext) BETWEEN 17 AND 16400)
    OR (state<>'ACTIVE' AND nonce IS NULL AND ciphertext IS NULL))
) STRICT;
CREATE TRIGGER sealed_identity_immutable BEFORE UPDATE ON sealed_records
WHEN NEW.namespace<>OLD.namespace OR NEW.record_id<>OLD.record_id OR NEW.kb_id<>OLD.kb_id
  OR NEW.owner_id<>OLD.owner_id OR NEW.version<>OLD.version
  OR (OLD.state='REVOKED' AND NEW.state<>'REVOKED')
BEGIN SELECT RAISE(ABORT,'sealed identity is immutable'); END;
CREATE TRIGGER sealed_identity_retained BEFORE DELETE ON sealed_records
BEGIN SELECT RAISE(ABORT,'sealed identity is retained'); END;
CREATE TABLE sealed_grants (
  namespace TEXT NOT NULL, record_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL CHECK(length(consumer_id)=36),
  recipient_key_id TEXT NOT NULL CHECK(length(recipient_key_id)=36),
  recipient_public_key TEXT NOT NULL CHECK(length(recipient_public_key)=44),
  expires_ms INTEGER NOT NULL CHECK(expires_ms>0),
  PRIMARY KEY(namespace,record_id,consumer_id,recipient_key_id),
  FOREIGN KEY(namespace,record_id) REFERENCES sealed_records(namespace,record_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE sealed_receipts (
  kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('ENROLL','GRANT','REVOKE')),
  idempotency_key TEXT NOT NULL, request_mac BLOB NOT NULL CHECK(length(request_mac)=32),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  PRIMARY KEY(kb_id,operation,idempotency_key)
) STRICT;
CREATE TABLE sealed_events (
  operation_id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES kbs(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('ENROLL','GRANT','REVOKE','RESOLVE_DENIED')),
  created_ms INTEGER NOT NULL
) STRICT;
-- Pack rollup back-off (`git_write::consolidate_objects`): the last deferred
-- or failed rollup of one KB's repository. The next one waits until the
-- repository's pressure (indexed packs plus loose sample) grows past `level`
-- by a step that doubles per deferral (fold or cleanup); completion deletes the row.
CREATE TABLE pack_consolidation (
  kb_id TEXT PRIMARY KEY REFERENCES kbs(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  level INTEGER NOT NULL CHECK (level >= 0),
  deferrals INTEGER NOT NULL CHECK (deferrals >= 1),
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0)
) STRICT;

-- One bounded fold's exact cleanup authority, committed before installation.
-- Keep object names even after an old index has been retired. Entries disappear
-- only after their filesystem retirement barriers; deleting intent cascades them.
CREATE TABLE pack_cleanup (
  kb_id TEXT PRIMARY KEY REFERENCES kbs(id) ON DELETE CASCADE,
  covering TEXT NOT NULL CHECK(length(covering)=40),
  names BLOB NOT NULL CHECK(length(names)%20=0)
) STRICT;
CREATE TABLE pack_cleanup_entries (
  kb_id TEXT NOT NULL REFERENCES pack_cleanup(kb_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('pack','loose')),
  name TEXT NOT NULL CHECK(length(name)=40),
  PRIMARY KEY(kb_id,kind,name)
) STRICT;
