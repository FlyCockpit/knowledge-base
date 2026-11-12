// Maximum number of procedures oRPC will pack into a single `__batch__`
// request. The web client (`BatchLinkPlugin`) and the server
// (`BatchHandlerPlugin`) MUST read this same constant — see below for what
// happens when they drift.
//
// Why a shared constant instead of two literals: the client's `maxSize` is a
// *splitting* threshold (it recursively halves an oversized batch), while the
// server's is a *rejection* threshold. So a client value above the server's
// does not degrade gracefully — the server answers the whole batch with an
// HTTP 413 and every query in it fails at once. The template previously
// shipped client=10 (the library default, left implicit) against server=3,
// which broke any page mounting 4+ concurrent queries in one tick.
//
// 10 matches the oRPC library default on both sides.
//
// IMPORTANT — diagnosing a 413 on `POST /rpc/<procedure>/__batch__`:
// that status means *procedure count*, not payload size. It is not Hono's
// `bodyLimit` (10 MB, and it returns a JSON body instead of the plain-text
// "Batch request size exceeds the maximum allowed size"), and it is not your
// reverse proxy's `client_max_body_size`. Do not "fix" it by raising limits
// in nginx/Traefik. Also note the batch URL is built from the *first*
// procedure in the batch, so the path in the failing request is a red
// herring — the other procedures in that batch are equally affected.
//
// To allow larger batches, change this value only. Never hardcode a
// different number on one side.
export const ORPC_BATCH_MAX_SIZE = 10;

/** Post-save ZIP acknowledgement; server EOF grace handles a lost reply. */
export const KB_EXPORT_ACK_TIMEOUT_MS = 5_000;
