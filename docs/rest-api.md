# REST API (control plane)

The REST API at `/api/v1` lets automation create, list, read and delete knowledge bases and mint child MCP tokens for them. It is the control plane only: it never reads or writes documents. Content work goes over [MCP](./mcp.md), done by the child tokens the API mints.

Example: a project manager creates one knowledge base per project, mints a propose-only MCP token for the project's agent, and deletes the knowledge base when the project is deleted.

The generated OpenAPI 3.1 document is served at `GET /api/v1/openapi.json` (no credential) and checked in as [rest-api.openapi.json](./rest-api.openapi.json). The access rules are in the [access matrix](./access-matrix.md#rest-control-plane-api-keys).

## API keys

A REST API key (`kbk_…`) is a different credential from an MCP token (`kbp_…`, OAuth or the CLI's device login):

- `/api/v1` takes only an API key. An MCP token there gets 401.
- `/mcp`, Git, asset and export downloads and the web app's `/rpc` refuse an API key with 401.

Create one in **Settings → API keys**. Only a signed-in person can mint a key, and the secret is shown once. A key always expires (default 90 days, at most 365) and cannot be edited afterwards; revoke it and mint a new one instead. At mint you choose:

| Choice | Meaning |
|---|---|
| Reach | **All knowledge bases I can access**, **Chosen knowledge bases**, or **Only knowledge bases this key creates**. KBs the key creates are always added to its reach. |
| Permissions | The most the key, and every token it mints, may do on a KB in its reach: read, propose, write, review or manage. |
| Create knowledge bases | `POST /kbs` is allowed. The new KB belongs to you. |
| Delete knowledge bases | `DELETE /kbs/{kbId}` is allowed. Needs manage in the permissions, and you must still own the KB. |
| Mint MCP tokens | `POST /kbs/{kbId}/tokens` is allowed. |
| Token tool groups and write mode | The most a minted token may hold. Sealed values are never available. |

A key never does more than you can do right now: every call intersects its permissions with your live access. If someone removes your share of a KB, the key loses it at once, and so do its tokens. A permanent ban, archiving or removing your account, or a lapsed forced-2FA grace revokes every key; a temporary ban suspends them until it ends.

## Child MCP tokens

`POST /api/v1/kbs/{kbId}/tokens` mints an ordinary MCP personal access token for one KB, within the key's ceilings and your live access. Use it with any MCP client exactly like a token from Settings → MCP. A child token:

- expires no later than its key (default: 90 days or the key's expiry, whichever is earlier);
- stops working as soon as its key is revoked or expires, and revoking the key revokes all of its tokens;
- cannot create knowledge bases and cannot mint anything;
- is listed under its key in Settings → API keys, and can be revoked there or with `DELETE /api/v1/tokens/{tokenId}`.

Each key may hold a limited number of live child tokens (default 200; an instance admin sets it in **Admin → Limits**). Child tokens do not count toward the 10 personal access tokens you can create in Settings.

## Requests and responses

- Authenticate with `Authorization: Bearer kbk_…`.
- Bodies are JSON (`Content-Type: application/json`, at most 16 KiB).
- Every mutation (`POST`, `DELETE`) needs an `Idempotency-Key` header: 1–128 characters from `A-Z a-z 0-9 _ -`. Retrying with the same key and the same body returns the same result; the same key with a different body is `409 IDEMPOTENCY_MISMATCH`. A refused request (for example 429, or a slug that is taken) never burns its key: send the same request again with the same key once the cause is gone. A changed request (say, another slug) needs a new key.
- Errors are `{"error": {"code": "…", "message": "…"}}` with a stable `code`: `INVALID_ARGUMENT` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT`, `IDEMPOTENCY_MISMATCH`, `QUOTA_EXCEEDED` (409), `RATE_LIMITED` (429), `STORAGE_UNAVAILABLE` (503).
- A 429 carries `Retry-After` (seconds) and `retryAfterSeconds`. A KB create over the hourly budget also names `limit` and `windowSeconds`.
- Lists are paged: `?limit=1..50&cursor=…`, and the response has `items` and `nextCursor` (`null` on the last page).

## Limits

| Limit | Default | Where it is set |
|---|---|---|
| KB creates per owner per hour (web, MCP and REST share it) | 5 | Admin → Limits |
| Live KBs one person may own | 20 | Admin → Limits |
| Live child tokens per API key | 200 | Admin → Limits |
| Child token mints per API key per hour | 200 | fixed |
| Live API keys per person | 10 | fixed |
| `/api/v1` requests per client IP | 120 per minute | fixed |

## Examples

```sh
export KB=https://kb.example.com
export KEY="$(cat ~/.config/kb-api-key)"   # kbk_…
```

Check the key:

```sh
curl -sS "$KB/api/v1/key" -H "Authorization: Bearer $KEY"
```

Create a knowledge base:

```sh
curl -sS -X POST "$KB/api/v1/kbs" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-project-42" \
  -d '{"name":"Project 42","slug":"project-42","description":"Notes for project 42."}'
# 201 {"operationId":"…","kb":{"id":"…","metadataVersion":1,"attachmentLocator":"…/mcp#kb=…",…}}
```

List and read:

```sh
curl -sS "$KB/api/v1/kbs?limit=20" -H "Authorization: Bearer $KEY"
curl -sS "$KB/api/v1/kbs/$KB_ID" -H "Authorization: Bearer $KEY"
```

Mint a propose-only MCP token for the KB:

```sh
curl -sS -X POST "$KB/api/v1/kbs/$KB_ID/tokens" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: agent-token-42" \
  -d '{"name":"Project 42 agent","bits":["propose"],"toolGroups":["read","edit"],"authoringMode":"edit"}'
# 201 {"token":{"id":"…","expiresAt":"…",…},"secret":"kbp_…","replayed":false}
```

Store `secret` right away: it is shown once. A retry with the same Idempotency-Key returns 200 with the same token and `"secret": null`; if the first response was lost, revoke that token and mint a new one with a new key.

List and revoke tokens:

```sh
curl -sS "$KB/api/v1/kbs/$KB_ID/tokens" -H "Authorization: Bearer $KEY"
curl -sS "$KB/api/v1/tokens" -H "Authorization: Bearer $KEY"
curl -sS -X DELETE "$KB/api/v1/tokens/$TOKEN_ID" \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: revoke-$TOKEN_ID"
```

Delete the knowledge base (same rules as the `knowledge_bases_delete` tool: the current `metadataVersion` and `"confirm":"DELETE"`):

```sh
curl -sS -X DELETE "$KB/api/v1/kbs/$KB_ID" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: delete-project-42" \
  -d '{"metadataVersion":1,"confirm":"DELETE"}'
# 200 {"operationId":"…","tombstoned":true}
```

There is no archive: deleting tombstones the KB, like the web app's delete.
