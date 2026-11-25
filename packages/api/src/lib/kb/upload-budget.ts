/**
 * Request budgets of the staged-upload surface (`kbUploads.begin/write/finish`),
 * sized for the payload rather than for general API traffic. Import-free: the
 * server's HTTP limiter (apps/server/src/rate-limit.ts) reads it too.
 *
 * One editor save at its largest is a 25 MiB image (`CAS_BLOB_MAX_BYTES`) and a
 * 2 MiB Markdown document (`STAGED_MARKDOWN_UPLOAD_MAX_BYTES`), each sent as
 * begin + 192 KiB frames (`UPLOAD_MAX_CHUNK_BYTES`) + finish: 134 + 11 + 4 =
 * 149 calls. upload-budget.test.ts pins these against the enforcing constants.
 */
const FRAME_BYTES = 196_608;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;

/** Upload calls one maximal editor save makes (begin/write/finish, image + Markdown). */
export const UPLOAD_CALLS_PER_MAX_SAVE =
  Math.ceil(IMAGE_MAX_BYTES / FRAME_BYTES) + Math.ceil(MARKDOWN_MAX_BYTES / FRAME_BYTES) + 4;

export const UPLOAD_BUDGET_WINDOW_SECONDS = 60;

/**
 * `rl:kb-upload`, the procedure budget per user: one maximal save plus room for
 * the replays of lost acknowledgements. Refusals carry `retryAfterSeconds`,
 * which the editor waits out from its last acknowledged frame.
 */
export const UPLOAD_PROCEDURE_POINTS = 160;

/**
 * `rl:kb-upload-http`, the HTTP requests of unbatched `POST /rpc/kbUploads/write`
 * per signed-in user, counted instead of the generic `/rpc` bucket. Above the
 * procedure budget so that budget, with its typed refusal, is what normally
 * refuses; this bucket only bounds frames that never reach the procedure.
 */
export const UPLOAD_FRAME_HTTP_POINTS = 200;
