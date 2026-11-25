# REST API (control plane)

The REST API at `/api/v1` lets automation create, list, read and delete knowledge bases and mint child MCP tokens for them. It is the control plane only: it never reads or writes documents. Content work goes over [MCP](./mcp.md), done by the child tokens the API mints.

Example: a project manager creates one knowledge base per project, mints a propose-only MCP token for the project's agent, and deletes the knowledge base when the project is deleted.

The generated OpenAPI 3.1 document is served at `GET /api/v1/openapi.json` (no credential) and checked in as [rest-api.openapi.json](./rest-api.openapi.json). The access rules are in the [access matrix](./access-matrix.md#rest-control-plane-api-keys).

## API keys

A REST API key (`kbk_…`) is a different credential from an MCP token (`kbp_…`, OAuth or the CLI's device login):

- `/api/v1` takes only an API key. An MCP token there gets 401.
- `/mcp`, Git, asset and export downloads and the web app's `/rpc` refuse an API key with 401.

Create one in **Settings → API keys**. Only a signed-in person can mint a key, and the secret is shown once. A key expires after 365 days by default; you can pick an earlier date or **never expires**. A key cannot be edited afterwards; revoke it and mint a new one instead. At mint you choose:

| Choice | Meaning |
|---|---|
| Reach | **All knowledge bases I can access**, **Chosen knowledge bases**, or **Only knowledge bases this key creates**. KBs the key creates are always added to its reach. |
| Permissions | The most the key, and every token it mints, may do on a KB in its reach: read, propose, write, review or manage. |
| Create knowledge bases | `POST /kbs` is allowed. The new KB belongs to you. |
| Delete knowledge bases | `DELETE /kbs/{kbId}` is allowed. Needs manage in the permissions, and you must still own the KB. Off also means no token minted by this key can ever delete a KB, even one it created. |
| Mint MCP tokens | `POST /kbs/{kbId}/tokens` is allowed. |
| Token tool groups and write mode | The most a minted token may hold: any option a personal access token from Settings → MCP can have. |
| Tokens may create knowledge bases | Off by default. On: a minted token may get `allowCreate` (it needs write access and the `kb_admin` group). |
| Sealed values tool group | Off by default. On: a minted token may carry the `sealed` group; it still resolves a sealed value only after you approve that exact token for it in the KB's sealed settings. |
| Tokens end when this key ends | Off by default: minted tokens are independent and keep working after the key expires or is revoked. On: they stop with the key, and none may expire later than it. |

A key never does more than you can do right now: every call intersects its permissions with your live access. If someone removes your share of a KB, the key loses it at once, and so do its tokens. A permanent ban, archiving or removing your account, or a lapsed forced-2FA grace revokes every key; a temporary ban suspends them until it ends.

## Child MCP tokens

`POST /api/v1/kbs/{kbId}/tokens` mints an ordinary MCP personal access token for one KB, within the key's ceilings and your live access. Use it with any MCP client exactly like a token from Settings → MCP. A child token:

- expires after 90 days by default, or on a date you choose (at most 365 days out), or never; if the key's tokens end with the key, never later than the key;
- keeps working after its key ends, unless the key's tokens end with it (then it stops as soon as the key is revoked or expires);
- can create knowledge bases only when the key allows it (it then also reaches the KBs it creates; `kbCount` in the lists counts them), and never mints tokens;
- is listed under its key in Settings → API keys (also after the key is revoked), and can be revoked there, all at once with **Revoke all tokens**, or with `DELETE /api/v1/tokens/{tokenId}`.

Revoking a key in Settings asks whether to revoke its tokens too: the choice is pre-selected from the key's "tokens end when this key ends" setting and you can change it at that moment. A key revoking itself with `DELETE /api/v1/key` may also revoke its independent tokens (`revokeChildren`), but it can never release tokens that end with it: those are always revoked with it.

Each key may hold a limited number of live child tokens (default 200; an instance admin sets it in **Admin → Limits**). Child tokens do not count toward the 10 personal access tokens you can create in Settings.

## Requests and responses

- Authenticate with `Authorization: Bearer kbk_…`.
- Bodies are JSON (`Content-Type: application/json`, at most 16 KiB).
- Creating and deleting (`POST /kbs`, `POST /kbs/{kbId}/tokens`, `DELETE /kbs/{kbId}`) need an `Idempotency-Key` header: 1–128 characters from `A-Z a-z 0-9 _ -`. Retrying with the same key and the same body returns the same result; the same key with a different body is `409 IDEMPOTENCY_MISMATCH`. A refused request (for example 429, or a slug that is taken) never burns its key: send the same request again with the same key once the cause is gone. A changed request (say, another slug) needs a new key.
- Revocations (`DELETE /tokens/{tokenId}`, `DELETE /key`) are naturally idempotent and take no Idempotency-Key: repeating a token revoke returns the same result; a key that revoked itself is gone, so a repeat answers 401.
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

Optional fields: `expiresAt` (a date, or `null` for never), `allowCreate` with `createdKbBits` (the bits on a KB the token creates).

Store `secret` right away: it is shown once. A retry with the same Idempotency-Key returns 200 with the same token and `"secret": null`; if the first response was lost, revoke that token and mint a new one with a new key.

List and revoke tokens:

```sh
curl -sS "$KB/api/v1/kbs/$KB_ID/tokens" -H "Authorization: Bearer $KEY"
curl -sS "$KB/api/v1/tokens" -H "Authorization: Bearer $KEY"
curl -sS -X DELETE "$KB/api/v1/tokens/$TOKEN_ID" \
  -H "Authorization: Bearer $KEY"
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

Revoke the key itself (for example when the automation is retired), keeping its independent tokens (tokens that end with the key are revoked with it; only you, in Settings, can release those):

```sh
curl -sS -X DELETE "$KB/api/v1/key" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"revokeChildren":false}'
# 200 {"id":"…","revoked":true,"children":0}
```
