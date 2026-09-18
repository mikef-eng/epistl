# 0017: MinIO object storage for avatars, accessed via presigned URLs

## Context

Epistl needs a place to store user avatar images. `apps/api/migrations/0001_create_users_table.sql`
already has a `users.image TEXT` column — Better Auth's standard
avatar-URL field — but it has never been populated or used, and there is
no object storage service in the stack today.

Two related questions had to be settled before building the upload/serving
endpoints (a separate, later issue):

1. **Where do the image bytes live**, and what (if anything) does Postgres
   hold about them?
2. **How do bytes move** between the mobile client, the API, and wherever
   they're stored — does the API proxy every byte, or hand out direct
   access to storage?

An earlier draft of this same issue considered having the API proxy image
bytes in both directions (client uploads to the API, API writes to
storage; API reads from storage, API streams to client) specifically to
avoid the client needing any direct access to the storage backend. The
repo owner confirmed the opposite is preferred: **presigned URLs**, MinIO's
own canonical, documented pattern (`presignedPutObject`/
`presignedGetObject`), provided the API remains the sole issuer/gatekeeper
of those URLs — it never hands out standing MinIO credentials to a client,
only short-lived, scoped URLs it alone can mint.

## Decision

**Why MinIO.** MinIO is chosen for local (and initially, production)
object storage specifically because it speaks the S3 API. That
compatibility is the point: a future migration to a cloud object store
(AWS S3, Cloudflare R2, etc.) requires only a config/endpoint change, not
a protocol or client rewrite — whatever S3 client the upload/serving
endpoint issue adds will work unmodified against any S3-compatible
backend.

**What's stored where.** Image bytes live only in MinIO. Postgres's
existing `users.image TEXT` column holds only a reference to the object —
specifically, the API's own serving path (e.g. `/api/avatar/{user_id}`) —
never the image bytes themselves and never a raw MinIO/S3 URL. This is
consistent with the spirit of
[`docs/decisions/0001-message-content-never-in-postgres.md`](0001-message-content-never-in-postgres.md)'s
"don't put bulk content in Postgres" precedent, even though that decision
is scoped to message content specifically, not avatars.

**Upload/download path design.** The API is the sole issuer of
short-lived presigned URLs; it never proxies image bytes itself:

- **Upload:** the client asks the API for a presigned PUT URL, then PUTs
  the image bytes directly to MinIO using that URL. The API's own bytes
  never see the image.
- **Download:** the API's `/api/avatar/{user_id}` route responds with a
  `302` redirect to a freshly-generated presigned GET URL. Existing client
  code that just points an `<Image>` component or `fetch()` at that stable
  path keeps working unchanged, while the actual image bytes flow directly
  from MinIO to the client, not through the API.

This was chosen over full API-byte-proxying for two reasons:

- It avoids a double-hop of bandwidth (client → API → storage, and
  storage → API → client) for image bytes that carry no reason to pass
  through the API's own process.
- It's the standard, canonical MinIO/S3 pattern per MinIO's own documented
  `presignedPutObject`/`presignedGetObject` cookbook, rather than a
  bespoke proxy layer this project would need to build and maintain
  itself.

It's still "through the backend" in the sense that actually matters: the
API is the only thing that can mint a presigned URL, because it alone
holds the MinIO secret key. Authorization (is this user allowed to
upload/view this avatar), per-user object-key scoping, and short URL
expiry are all still centrally enforced by the API for every presigned URL
it issues. The client never receives standing or direct MinIO credentials
— only a URL that is valid for one operation, for a short window.

**Two endpoints, not one.** Two distinct endpoint env vars are needed —
this is a well-known MinIO-behind-Docker gotcha, not a hypothetical:

- `MINIO_INTERNAL_ENDPOINT` (e.g. `http://minio:9000`, the docker-compose
  service hostname) — used by the API for admin operations (e.g. bucket
  creation) and to actually *sign* presigned URLs.
- `MINIO_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000` in local dev) —
  the host-reachable address that must appear as the hostname *inside* any
  presigned URL handed to the mobile client, since the client cannot
  resolve the `minio` docker-compose service name. The upload/serving
  endpoint issue's presigned-URL generation must rewrite/construct URLs
  using this public endpoint, not whatever endpoint the MinIO SDK client
  was itself configured to talk to internally.

**Bucket creation is out of scope here.** This issue (`docker-compose.yml`
+ env vars + this decision doc) does not create the `avatars` bucket
(`AVATAR_BUCKET_NAME` in `.env.example`). Idempotent bucket creation (e.g.
on API startup) is the responsibility of the later upload/serving endpoint
issue.

## Consequences

- A new service (`minio`) is added to `docker-compose.yml`, with a named
  volume (`epistl-minio-data`) and a healthcheck, matching the
  `postgres`/`nats` pattern already in that file.
- Local dev requires `docker compose up -d` to also bring up MinIO;
  `README.md`'s Stack table and "Running the stack locally" section
  reflect this.
- A later issue adds an S3-compatible Rust client dependency to
  `apps/api/Cargo.toml` and the actual `/api/avatar/{user_id}` and
  presigned-PUT-URL endpoints. That issue is intentionally kept separate
  (and atomic) both because it's a new dependency and because it's the
  point where authorization and object-key scoping actually get enforced.
- No `apps/api/migrations/` change is needed for this issue: the existing
  `users.image TEXT` column is reused as-is to hold the API's own avatar
  serving path once the later issue starts populating it.
- Any future non-avatar use of object storage (e.g. message attachments,
  if ever added) should reuse this same MinIO service and the same
  presigned-URL pattern rather than introducing a second storage backend
  or a byte-proxying path, unless a new decision doc justifies deviating.
