# Async work in the CLI

Tokio is already used for remote MCP, device login, provider probes and local
stdio dispatch. Reuse the process runtime, `crate::runtime()`, and the existing
cancellation/deadline paths; keep command parsing and synchronous local-owner
commands synchronous. Do not replace `main`, and never build a runtime per call
or request: dropping a runtime waits for every blocking task it spawned, so
abandoned blocking work (a stalled resolver) would hold the reply. Request
handlers run on the stdio loop's blocking pool and enter the shared runtime with
`Handle::block_on` (see `kb_local::dispatch::Session`).

Networking belongs in kb-client or the existing local egress boundary. Blocking
Git/SQLite work must retain its owning fence until children and I/O drain;
returning a timeout alone does not release ownership safely. Logs use stderr,
while stdout stays available for JSON/MCP. Add only necessary features to the
existing workspace dependency after approval when a new dependency is needed.

Run the [CLI gate](../AGENTS.md) and discriminating cancellation/re-entry tests.
See [operator CLI documentation](../../../docs/cli.md) for the supported commands.
