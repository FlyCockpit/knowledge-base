# Git, proposals and mirrors

Git is the canonical Markdown and manifest history. Clone URL:
`https://kb.example/git/<kbId>.git` (KB ID, not display slug). The UI shows the
exact URL. Use an arbitrary Basic username and enter the PAT as the password
through Git's prompt/private credential manager. Read permission is required;
cookies and OAuth tokens in the password field are rejected. Keep credentials
out of the clone URL and shell history.

```sh
git clone https://kb.example/git/abcdefghijklmnopqrstuvwx.git knowledge
cd knowledge
git switch -c research
# Edit Markdown, then commit locally.
git push origin HEAD:refs/heads/research
```

## Push admission

Every accepted push is single-ref and fast-forward only, with a compare-and-swap
against its old SHA. Multi-ref pushes, force pushes, branch deletes, tags and
other namespaces are rejected before canonical refs change. Parseable refused pushes receive a report for every ref (`! [remote rejected] <ref> (<reason>)`), and content refusals include their validation code and path when available. These are logged as refusals rather than server errors. Push main needs
write; creating a nondefault USER branch needs propose. Only the actor owning
that branch may advance it. Branch history within a readable KB is readable by
other readers; a proposal branch is not a private workspace.

`refs/heads/pr/<number>` is reserved for server-generated automatic proposals;
no Git actor may push it. Propose-only MCP edits reuse the actor's active auto-PR;
write holders publish to main unless they explicitly select an owned active
proposal. Only main is indexed. Closed/merged proposal branches remain retained
and immutable. Resolve non-FF rejection locally by fetching and updating your
branch; do not rewrite published server refs.

Validation covers every newly reachable commit, not only the tip: safe UTF-8/NFC
paths, unique IDs, restricted YAML, manifests with already authorized CAS lineage,
4096 files/8192 entries, depth 32, 2 MiB Markdown and 64 MiB tree. Only Markdown,
the fixed comment-only `.gitignore` and `.assets/manifest.json` belong in Git;
no binaries, symlinks, executable modes, gitlinks or LFS. Push budgets include
50 MiB encoded request, 512 new commits, 100,000 objects/128 MiB expanded objects,
120 s upload/10 s inactivity, then 60 s execution and 5 s force-drain.

## Reviewed PR merge

Create a PR from your owned USER branch with expected source and main SHAs.
The review shows immutable before/after Markdown and touched assets; fetch all
pages before deciding. Merge needs review, confirm MERGE, `expectedHeadSha` and
`expectedTargetSha` from that displayed diff. Write does not imply review.
A nonempty reviewed merge creates a two-parent audit commit, even when main
is an ancestor of the proposal. A clean divergent merge uses the same parent
order: main first and proposal second. The commit records the PR and reviewer,
and main advances by fast-forward to it. Read-only mergeability checks do not
create this commit.
True content or dream-provenance conflicts require updating the branch. A moved
source/main conflicts before publication; refresh the diff and confirm again.
Close needs review or the original author with current propose, confirm CLOSE.

Fixture review input (the zero SHAs must be replaced by actual displayed SHAs):

```json kb/1 knowledge_pull_requests_review input
{
  "confirm": "MERGE",
  "decision": "merge",
  "expectedHeadSha": "0000000000000000000000000000000000000000",
  "expectedTargetSha": "0000000000000000000000000000000000000000",
  "idempotencyKey": "fixture-idempotency-key-01",
  "kbId": "abcdefghijklmnopqrstuvwx",
  "number": 1
}
```

The server is the single canonical writer. A native lifetime fence drains Git
children before another process enters; authority then sorted KB locks protect
the durable one-ref journal. Startup recovers intended/old refs once. A third
unexpected SHA marks REPAIR_REQUIRED; operators must inspect, never reset refs
or delete lock files to bypass it. Lost publication replies can mean a committed
operation: retry the identical key or inspect the PR/ref.

## One-way external mirror

A manager configures `ssh://git@host[:port]/owner/repo.git` in the human control
plane. Verify full pinned host keys out of band, install the displayed public
Ed25519 deploy key remotely, then activate the pending key. Private keys are
encrypted under `KB_MASTER_KEY`; no private key is returned. Push main is an
explicit human action, never pull-back, automatic dreaming or search side effect.
The worker uses private tmpfs key scratch. It mounts the data volume
read-write, so a compromised worker could modify canonical repositories; Git
hash verification, process fences and backups remain (see [deployment](./deploy.md)).
Remote divergence fails; no force overwrite is offered. Rotation activates a
verified pending key and retires old ciphertext after reserved work drains.
Disconnect drains network groups and destroys live key ciphertext. A lost reply
can have an unknown remote outcome: inspect advertised main before retrying.
Ownership transfer and restore disconnect mirrors; the new authority reconnects
with fresh credentials. See [deployment](./deploy.md) and [restore](./backup-restore.md).

## Scheduled object maintenance

The worker schedules `kb-git-rollup` every five minutes, independently of saves and pushes. Each firing visits at most 16 active KBs, advances a durable keyset cursor, and spends at most 45 seconds overall. A KB uses the same operation lock as publication and receive-pack, with a 250 ms admission wait and a two-second rollup budget.

The rule matches the CLI local store: eight small packs or 27 eligible loose objects in fanout `17` trigger a geometric rollup. A pass folds at most 32 MiB of compressed inputs and 20,000 loose objects; packs at least 16 MiB or 100,000 objects are frozen. Loose inputs share a 16 MiB allowance. Individually larger loose files remain retained in place and do not count toward maintenance pressure. Selection skips files that exceed either the individual allowance or the remaining batch budget and continues its bounded scan. Planning obeys both the byte and 200,000-object budgets, using the larger normalized resource for the geometric progression. Input indexes and the resulting pack are verified, and every input object is retained, including unreachable objects. This is compaction, with no history or asset garbage collection. Output, object count and directory scans are bounded too.

Installation fsyncs pack data before publishing its index. A durable intent protects retirement and resumes interrupted work under the KB lock; existing Git readers can keep open packs and rediscover the replacement. Per-KB failed folds persist retry spacing: retries resume after five minutes (doubling to 80 minutes), or earlier after enough pressure growth. Both caps stay fixed. Cancellation and post-install cleanup never increment the failed-fold counter. Cleanup retries use the installed covering pack and durable intent without repacking. Temporary storage is reserved through the shared filesystem quota account, retained across interruption and released after scratch cleanup drains. All maintenance SQL uses deadline-aware owned sessions. Structured `worker.kb-git-rollup` records report idle, completed and deferred passes without document text or raw errors.
