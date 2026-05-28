# cws-as Dependency Coverage

This doc lists the cws-as HTTP endpoints that **zylos-coco-workspace** depends on, and for each one:

- whether it exists in **cws-as** today
- whether it is forwarded by **cws-core** today
- what it does (Summary / Description, verbatim from the Huma operation registration)
- input schema (path + query + body)
- output schema

The "dependency" side is sourced from `src/cli/as.js` only — every place in coco-workspace that talks to cws-as routes through that file via `src/lib/client.js`'s `asClient()`.

Service sources:
- cws-as routes: `cws-as/internal/transport/http/{artifact,upload,download,resolve}_handler.go`
- cws-core routes: `cws-core/internal/transport/http/` (entire tree was searched — see [Coverage Summary](#coverage-summary))

> Generated 2026-05-28. Re-generate when either side changes its route table.

---

## Coverage Summary

| # | Method | Path | as.js call site | cws-as | cws-core forward |
|---|---|---|---|---|---|
| 1 | POST   | `/api/v1/artifacts`                       | `as.js:103` (`uploadMedia` step 1) | ✅ `artifact_handler.go:189` | ❌ |
| 2 | POST   | `/api/v1/artifacts/{id}/finalize`         | `as.js:138` (`uploadMedia` step 3) | ✅ `upload_handler.go:114`   | ❌ |
| 3 | POST   | `/api/v1/artifacts/{id}/abort`            | `as.js:160` (`as.abort`)           | ✅ `upload_handler.go:139`   | ❌ |
| 4 | GET    | `/api/v1/artifacts/{id}/download`         | `as.js:173` (`as.download`)        | ✅ `download_handler.go:35`  | ❌ |
| 5 | POST   | `/api/v1/artifacts/resolve`               | `as.js:204` (`as.resolve`)         | ✅ `resolve_handler.go:41`   | ❌ |
| 6 | GET    | `/api/v1/artifacts`                       | `as.js:225` (`as.list`)            | ✅ `artifact_handler.go:258` | ❌ |
| 7 | GET    | `/api/v1/artifacts/{id}`                  | `as.js:237` (`as.get`)             | ✅ `artifact_handler.go:241` | ❌ |
| 8 | PATCH  | `/api/v1/artifacts/{id}`                  | `as.js:244` (`as.update`)          | ✅ `artifact_handler.go:306` | ❌ |
| 9 | DELETE | `/api/v1/artifacts/{id}`                  | `as.js:255` (`as.delete`)          | ✅ `artifact_handler.go:338` | ❌ |

- **cws-as side:** 9/9 implemented.
- **cws-core side:** 0/9 — `grep -rn artifact cws-core/` returns zero hits. No handler, no proxy, no router registration.

There is also a non-endpoint step in the upload flow (`as.js:135`): a direct `PUT` to a presigned URL returned by cws-as. That URL targets the underlying object store (S3 / MinIO), not cws-as itself, so it is not part of cws-as's route table.

---

## Per-endpoint detail

For each endpoint, "Input" lists path/query/body fields; "Output" is the response body schema. Field names and types are copied from the `huma.Operation` struct tags on the cws-as side.

### 1. `POST /api/v1/artifacts` — Create an artifact

Reserve artifact metadata. First step of the upload pipeline (or the only step if you only need a metadata stub).

**Input (body):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | ✅ | Artifact name |
| `description` | string | | Optional |
| `mime_type` | string | ✅ | MIME type |
| `mime_category` | string | | MIME category |
| `size_bytes` | int64 | ✅ | File size in bytes |
| `storage_class` | string | | Storage class |
| `producer_issue_id` | string | | |
| `producer_task_id` | string | | |
| `producer_principal_id` | string | | |
| `producer_type` | string | | |
| `artifact_class` | string | | |
| `is_confidential` | bool | | |
| `contains_pii` | bool | | |
| `metadata` | object | | |

**Output (body):** full `artifactBody` (see [Common types](#common-types)).

---

### 2. `POST /api/v1/artifacts/{artifact_id}/finalize` — Finalize an upload session

"Verify the uploaded content, transition the artifact to active status, and return the updated artifact."

**Input:**
- path: `artifact_id` (string)
- body: `{ "session_id": string }` (required)

**Output (body):** full `artifactBody`.

---

### 3. `POST /api/v1/artifacts/{artifact_id}/abort` — Abort an upload session

"Cancel an in-progress upload session and release reserved quota."

**Input:**
- path: `artifact_id` (string)
- body: `{ "session_id": string }` (required)

**Output:** empty body (204 / 200 no content).

---

### 4. `GET /api/v1/artifacts/{artifact_id}/download` — Generate a presigned download URL

"Returns a presigned GET URL for downloading an artifact. Use `mode=preview` for inline content disposition or `mode=download` (default) for attachment."

**Input:**
- path: `artifact_id` (string)
- query: `mode` — `download` (default, `Content-Disposition: attachment`) or `preview` (inline)

**Output (body):**

| Field | Type | Notes |
|---|---|---|
| `download_url` | string | Presigned download URL |
| `expires_at` | int64 | URL expiration (Unix ms) |
| `content_type` | string | MIME type |
| `content_length` | int64 | File size in bytes |
| `filename` | string | Original filename |

---

### 5. `POST /api/v1/artifacts/resolve` — Batch resolve `as://` URIs

"Resolves up to 100 `as://{orgId}/{artifactId}/{fileName}` URIs into presigned download URLs. URIs that cannot be resolved (wrong org, not found, inactive) are returned in the `failed` list."

**Input (body):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `uris` | string[] | ✅ | `as://` URIs (max 100) |
| `inline` | bool | | Inline disposition + shorter TTL |

**Output (body):**

| Field | Type | Notes |
|---|---|---|
| `resolved` | map[string → resolvedURI] | URI → `{download_url, expires_at, content_type, content_length, name}` |
| `failed` | string[] | URIs that could not be resolved |

---

### 6. `GET /api/v1/artifacts` — List artifacts

Filtered + cursor-paginated list of artifacts.

**Input (query):**

| Field | Type | Notes |
|---|---|---|
| `mime_category` | string | Filter by MIME category |
| `status` | string | Filter by status |
| `producer_type` | string | Filter by producer type |
| `class` | string | Filter by artifact class |
| `cursor` | string | Pagination cursor |
| `limit` | int | 1..200, default 50 |

**Output (body):**

| Field | Type | Notes |
|---|---|---|
| `artifacts` | artifactBody[] | Page of artifacts |
| `next_cursor` | string | Empty when no more pages |

---

### 7. `GET /api/v1/artifacts/{artifact_id}` — Get an artifact by ID

**Input:** path `artifact_id` (string)

**Output (body):** full `artifactBody`.

---

### 8. `PATCH /api/v1/artifacts/{artifact_id}` — Update artifact metadata

"Only active or archived artifacts can be updated. Mutable fields: name, description, metadata, is_confidential, contains_pii, artifact_class."

**Input:**
- path: `artifact_id` (string)
- body (all optional, all pointer types — partial update):

| Field | Type | Notes |
|---|---|---|
| `name` | *string | New name |
| `description` | *string | New description |
| `metadata` | object | New metadata |
| `is_confidential` | *bool | |
| `contains_pii` | *bool | |
| `artifact_class` | *string | |

**Output (body):** full `artifactBody`.

---

### 9. `DELETE /api/v1/artifacts/{artifact_id}` — Soft-delete an artifact

Marks the artifact deleted in the 8-state machine. Hard delete is a separate later step driven by `hard_delete_after`.

**Input:** path `artifact_id` (string)

**Output:** empty body.

---

## Common types

### `artifactBody`

Returned by create / get / list / update / finalize. Field set (from `artifact_handler.go:20`):

| Field | Type | Notes |
|---|---|---|
| `id`                    | string    | Artifact ID |
| `org_id`                | string    | |
| `name`                  | string    | |
| `description`           | string    | optional |
| `mime_type`             | string    | |
| `mime_category`         | string    | |
| `size_bytes`            | int64     | |
| `content_hash`          | string    | optional |
| `storage_uri`           | string    | optional |
| `status`                | string    | 8-state machine: `creating` → `pending_verification` → `active` → `archived` → `deleted` → `hard_deleted`; also `hash_mismatch`, `blocked` |
| `storage_class`         | string    | |
| `current_version`       | int       | |
| `version_count`         | int       | |
| `producer_issue_id`     | string    | optional |
| `producer_task_id`      | string    | optional |
| `producer_principal_id` | string    | optional |
| `producer_type`         | string    | optional |
| `artifact_class`        | string    | |
| `is_confidential`       | bool      | |
| `contains_pii`          | bool      | |
| `scan_status`           | string    | |
| `scan_result`           | object    | optional |
| `metadata`              | object    | optional |
| `created_by`            | string    | |
| `created_at`            | timestamp | |
| `updated_at`            | timestamp | |
| `finalized_at`          | timestamp | optional |
| `archived_at`           | timestamp | optional |
| `deleted_at`            | timestamp | optional |
| `hard_delete_after`     | timestamp | optional |
| `last_accessed_at`      | timestamp | optional |

---

## Findings worth flagging

A handful of param mismatches surfaced while writing this doc. They are not strictly part of the coverage question, but anyone using this doc as the source of truth should know.

### F1 — Our `uploadMedia` skips the initiate-upload session step

cws-as's actual upload flow is **3 server hops**:

1. `POST /api/v1/artifacts` → creates artifact metadata, returns `artifactBody` (**no `upload_url`**)
2. `POST /api/v1/artifacts/{id}/upload` → initiates upload session, returns `{ session_id, upload_url, headers, expires_at, instant_upload }`
3. `POST /api/v1/artifacts/{id}/finalize` → body `{ session_id }`, returns final `artifactBody`

`src/cli/as.js:103-141` instead does:

1. `POST /api/v1/artifacts` with extra fields `content_hash`, `description`, `metadata` (the first is silently dropped — not in createArtifactInput; the latter two are valid)
2. Reads `init.upload.upload_url` and `init.instant_upload` directly from that response — these fields **are not returned by cws-as create-artifact today**
3. `POST /api/v1/artifacts/{id}/finalize` with body `{ content_hash, content_length }` — but cws-as `finalizeUploadInput` expects `{ session_id }`

Net effect today: any non-trivial upload through `as.upload` will fail because step 1 returns no `upload.upload_url`. We need to insert a `POST /api/v1/artifacts/{id}/upload` call between steps 1 and 2, capture `session_id`, then pass that into finalize.

### F2 — `as.abort` sends no body

`src/cli/as.js:160` does `asClient().post(\`/api/v1/artifacts/${artifactId}/abort\`)` with no body. cws-as `abortUploadInput.Body.SessionID` is `required:"true"`. We'd need to thread `session_id` through.

### F3 — Out-of-scope routes cws-as exposes that we don't use

For completeness:
- `POST /api/v1/artifacts/{id}/upload` — initiate upload session (we should be calling this — see F1)
- `POST /api/v1/artifacts/batch` — batch-get metadata by IDs (used by cws-comm and cws-kb)

If/when we wire artifact attachment into `kb.upload` proper, `POST /artifacts/batch` is the natural fit for resolving lists of artifact IDs.

---

## Re-generating this doc

When cws-as adds, removes, or renames a route:

```bash
cd cws-as
grep -rnE 'Path:\s*"/api/v1' internal/transport/http/
```

When checking cws-core forwarding coverage:

```bash
cd cws-core
grep -rnE "artifact" internal/ pkg/ cmd/
```
