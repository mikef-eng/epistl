# 0018: SeaweedFS object storage for avatars, accessed via presigned URLs

## Context

Issue #180 (merged as PR #186, commit `a910370`) stood up MinIO for avatar
image storage, documented in the now-deleted
`docs/decisions/0017-minio-object-storage-for-avatars.md`. That decision
was live for about a day before MinIO Community Edition turned out to be a
dead end: its admin web console was stripped out of the open-source build
in May 2025 (moved to the paid enterprise product), the project went into
GitHub "maintenance mode" in December 2025, and was marked "no longer
maintained" and archived in February 2026. This is not a licensing
inconvenience — the project is dead upstream. MinIO was tried first and
abandoned purely for this reason, not for any design-quality problem with
the presigned-URL approach itself.

This issue reverts #180's `docker-compose.yml`/`.env.example`/README/
AGENTS.md changes and replaces MinIO with SeaweedFS (Apache-2.0, actively
maintained, a genuine S3-compatible gateway with real presigned-URL
support), preserving the exact same conceptual design already agreed for
MinIO in 0017: the API is the sole issuer of short-lived presigned PUT/GET
URLs and never proxies bytes; `users.image TEXT` stores only the API's own
`/api/avatar/{user_id}` serving path.

All facts below were verified hands-on (2026-09-18): pulled
`chrislusf/seaweedfs:4.47` (the latest stable GitHub release tag),
inspected `docker run chrislusf/seaweedfs:4.47 mini -h` for the exact flag
set, then brought up a `weed mini` container via docker-compose and ran a
full presigned PUT + GET round trip against it (boto3 to generate the
presigned URLs against the *public* endpoint, plain `curl` to execute the
PUT/GET from outside the container) — it worked end to end.

## Decision

**Why SeaweedFS.** Same S3-API-compatibility rationale as 0017: a future
migration to a cloud object store (AWS S3, Cloudflare R2, etc.) requires
only a config/endpoint change, not a protocol or client rewrite. SeaweedFS
additionally speaks real S3-compatible presigned URLs and is actively
maintained (Apache-2.0), unlike archived MinIO Community Edition.

**Why `weed mini` (all-in-one), not the full multi-service topology.**
This repo's `docker-compose.yml` is a single-node local-dev stack.
SeaweedFS's own example multi-container topology (separate `master`/
`volume`/`filer`/`s3` services, as shown in its GitHub repo's
`docker/compose/seaweedfs-compose.yml`) is needless complexity here. `weed
mini` is SeaweedFS's own all-in-one single-process mode (master + volume +
filer + S3 gateway combined in one container) — confirmed via `weed mini
-h` and also the image's own documented default `CMD` — and is the right
shape for this stack.

**Everything carried over unchanged in spirit from 0017:**

- **What's stored where.** Image bytes live only in SeaweedFS. Postgres's
  existing `users.image TEXT` column holds only a reference — the API's
  own serving path (e.g. `/api/avatar/{user_id}`) — never the image bytes
  themselves and never a raw SeaweedFS/S3 URL. Consistent with the spirit
  of
  [`docs/decisions/0001-message-content-never-in-postgres.md`](0001-message-content-never-in-postgres.md).
- **Upload/download path design.** Upload: the client asks the API for a
  presigned PUT URL, then PUTs the image bytes directly to SeaweedFS. The
  API's own bytes never see the image. Download: the API's
  `/api/avatar/{user_id}` route responds with a `302` redirect to a
  freshly-generated presigned GET URL. The API remains the sole
  issuer/gatekeeper of short-lived presigned URLs, never proxying bytes
  itself.

**The two-endpoint requirement, carried over and re-verified.** Two
distinct endpoint env vars are needed, same reasoning as MinIO's
`MINIO_INTERNAL_ENDPOINT`/`MINIO_PUBLIC_ENDPOINT`:

- `SEAWEEDFS_INTERNAL_ENDPOINT` (`http://seaweedfs:8333`, the
  docker-compose service hostname) — used by the API for admin operations
  and to actually *sign* presigned URLs.
- `SEAWEEDFS_PUBLIC_ENDPOINT` (`http://localhost:8333` in local dev) — the
  host-reachable address that must appear as the hostname *inside* any
  presigned URL handed to the mobile client, since the client cannot
  resolve the `seaweedfs` docker-compose service name. Re-verified
  hands-on: a presigned URL's SigV4 signature is bound to the host in the
  URL, so connecting to a different host than the one signed against fails
  with `AccessDenied`/`SignatureDoesNotMatch`.

**Credentials mechanism differs from MinIO.** SeaweedFS's S3 gateway takes
static credentials from a mounted JSON identity/credential file
(`docker/seaweedfs-s3-config.json`), not from simple root-user/password env
vars the way `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` worked. This is a new
local-dev gotcha: the `SEAWEEDFS_S3_ACCESS_KEY`/`SEAWEEDFS_S3_SECRET_KEY`
values in `.env.example` must exactly match the `accessKey`/`secretKey`
values in `docker/seaweedfs-s3-config.json` — nothing wires the env vars
into the JSON file automatically, so changing one without the other breaks
authentication silently.

**Path-style S3 addressing is required.** Confirmed hands-on: generating a
presigned URL against SeaweedFS's S3 gateway requires
`addressing_style: path` (boto3) — the equivalent of
`force_path_style(true)` in the AWS Rust SDK (`aws-sdk-s3`) — rather than
virtual-hosted-style. Flagged here so the later server-side endpoint issue
doesn't rediscover this the hard way.

**Bucket creation moved to infra — a simplification versus MinIO.** Unlike
0017 (where bucket creation was deferred to the later API endpoint issue),
the `seaweedfs` compose service's `S3_BUCKET` env var makes `weed mini`
auto-create the `avatars` bucket at container startup itself (verified via
the container log line `created bucket avatars`). The later
upload/serving endpoint issue no longer needs its own idempotent
bucket-creation-on-API-startup logic.

## Consequences

- `docker-compose.yml`'s `minio` service and `epistl-minio-data` volume are
  removed; a `seaweedfs` service (`chrislusf/seaweedfs:4.47`, `weed mini`)
  and `epistl-seaweedfs-data` volume are added, plus a checked-in
  `docker/seaweedfs-s3-config.json` bind mount for S3 credentials.
- `.env.example`'s `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`/
  `MINIO_INTERNAL_ENDPOINT`/`MINIO_PUBLIC_ENDPOINT` are replaced with
  `SEAWEEDFS_S3_ACCESS_KEY`/`SEAWEEDFS_S3_SECRET_KEY`/
  `SEAWEEDFS_INTERNAL_ENDPOINT`/`SEAWEEDFS_PUBLIC_ENDPOINT`.
  `AVATAR_BUCKET_NAME` is unchanged.
- A later issue adds an S3-compatible Rust client dependency to
  `apps/api/Cargo.toml` (with path-style addressing enabled, per above) and
  the actual `/api/avatar/{user_id}` and presigned-PUT-URL endpoints. That
  issue no longer needs bucket-creation logic, per above.
- No `apps/api/migrations/` change is needed for this issue: the existing
  `users.image TEXT` column is reused as-is.
- Any future non-avatar use of object storage (e.g. message attachments,
  if ever added) should reuse this same SeaweedFS service and the same
  presigned-URL pattern rather than introducing a second storage backend
  or a byte-proxying path, unless a new decision doc justifies deviating.
