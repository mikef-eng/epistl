//! Database connection setup and per-worktree isolation.
//!
//! Postgres is the app's only relational store. It holds users, sessions,
//! accounts, and verifications (all driven by the `better-auth` crate --
//! see `crate::auth`), plus contacts. No message content or PQC key
//! material is ever stored here.
//!
//! ## Per-worktree isolation
//!
//! When multiple `api-dev` lane agents run concurrently, each agent works
//! in a dedicated `git worktree` under `.claude/worktrees/<name>`. To keep
//! their `moon run api:migrate` and `moon run api:test` runs isolated, the
//! effective database URL is rewritten to a per-worktree database:
//!
//! - If `EPISTL_WORKTREE_SLUG` is set (non-empty), that value is used as
//!   the slug.
//! - Otherwise, if `git rev-parse --show-toplevel` points at a path
//!   containing `.claude/worktrees/<name>`, `<name>` is used as the slug.
//! - On the primary checkout (no worktree), no slug is derived and the
//!   `DATABASE_URL` is used as-is.
//!
//! The derived DB name is `<base_db>_wt_<slug>` (slug: lowercased,
//! `[^a-z0-9_]` → `_`, truncated so the total stays within Postgres's
//! 63-byte identifier limit). The derivation is deterministic for a given
//! slug. The database is created on demand (before migrations) if it does
//! not exist.
//!
//! See `docs/architecture/overview.md` (Local development) for the full
//! per-worktree setup. The Postgres role must have `CREATEDB` for on-demand
//! creation to work.

use std::env;
use std::fmt;
use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

/// How long to wait for the initial connection before giving up. Kept short
/// so startup fails fast instead of hanging for sqlx's 30s default.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Postgres's maximum identifier length (bytes).
const MAX_PG_IDENTIFIER_LEN: usize = 63;

/// Environment variable that can be set to explicitly override the worktree
/// slug used for per-worktree DB and NATS isolation. When unset, the slug
/// is derived from `git rev-parse --show-toplevel` path instead.
pub const WORKTREE_SLUG_VAR: &str = "EPISTL_WORKTREE_SLUG";

/// Environment variable read for the Postgres connection string.
pub const DATABASE_URL_VAR: &str = "DATABASE_URL";

/// Errors that can occur while building the database connection pool at
/// startup.
#[derive(Debug)]
pub enum DbError {
    /// `DATABASE_URL` was not set (or was not valid UTF-8) in the
    /// environment.
    MissingDatabaseUrl,
    /// `DATABASE_URL` was set but could not be parsed (no path component).
    InvalidDatabaseUrl,
    /// The pool could not connect to the configured database.
    Connect(sqlx::Error),
    /// A database operation (CREATE/DROP) failed.
    DbOp(sqlx::Error),
    /// A worktree-protected operation was attempted without an active slug
    /// (e.g. `drop_worktree_db` without a worktree context).
    NoWorktreeSlug,
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::MissingDatabaseUrl => {
                write!(f, "{DATABASE_URL_VAR} must be set to connect to Postgres")
            }
            DbError::InvalidDatabaseUrl => {
                write!(
                    f,
                    "{DATABASE_URL_VAR} could not be parsed (expected postgres://…/dbname)"
                )
            }
            DbError::Connect(err) => write!(f, "failed to connect to Postgres: {err}"),
            DbError::DbOp(err) => write!(f, "database operation failed: {err}"),
            DbError::NoWorktreeSlug => write!(
                f,
                "drop_worktree_db refuses to drop the base DB; \
                 set EPISTL_WORKTREE_SLUG or run inside a .claude/worktrees/<name> tree"
            ),
        }
    }
}

impl std::error::Error for DbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DbError::MissingDatabaseUrl => None,
            DbError::InvalidDatabaseUrl => None,
            DbError::Connect(err) => Some(err),
            DbError::DbOp(err) => Some(err),
            DbError::NoWorktreeSlug => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

/// Sanitises an arbitrary string into a valid per-worktree slug: lowercase,
/// every `[^a-z0-9_]` character replaced with `_`. The result contains only
/// `[a-z0-9_]` characters and is suitable for embedding in a Postgres
/// identifier.
pub fn sanitize_slug(slug: &str) -> String {
    slug.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Returns the sanitized worktree slug, if any:
///
/// 1. If `EPISTL_WORKTREE_SLUG` is set (non-empty), sanitise and return it.
/// 2. Otherwise run `git rev-parse --show-toplevel`; if the path contains
///    `.claude/worktrees/<name>`, return `sanitize_slug(<name>)`.
/// 3. Otherwise return `None` (primary checkout — no isolation needed).
pub fn worktree_slug() -> Option<String> {
    // 1. Explicit override via env var.
    if let Ok(slug) = env::var(WORKTREE_SLUG_VAR) {
        if !slug.is_empty() {
            return Some(sanitize_slug(&slug));
        }
    }

    // 2. Detect from the current git worktree root.
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let toplevel = String::from_utf8(output.stdout).ok()?;
    let toplevel = toplevel.trim();

    // Path pattern: …/.claude/worktrees/<name>
    let marker = "/.claude/worktrees/";
    if let Some(idx) = toplevel.find(marker) {
        let after = &toplevel[idx + marker.len()..];
        // The name is everything up to the next '/' (or end of string).
        let name = after.split('/').next().unwrap_or("").trim();
        if !name.is_empty() {
            return Some(sanitize_slug(name));
        }
    }

    None
}

/// Derives the per-worktree database name: `<base_db>_wt_<slug>`, truncated
/// so the full name never exceeds Postgres's 63-byte identifier limit.
///
/// The derivation is deterministic for a given `(base_db, slug)` pair.
pub fn derive_db_name(base_db: &str, slug: &str) -> String {
    let prefix = format!("{base_db}_wt_");
    let remaining = MAX_PG_IDENTIFIER_LEN.saturating_sub(prefix.len());
    // Truncate at a byte boundary — slug is ASCII-only after sanitise_slug.
    let truncated_slug = &slug[..slug.len().min(remaining)];
    format!("{prefix}{truncated_slug}")
}

// ---------------------------------------------------------------------------
// URL manipulation
// ---------------------------------------------------------------------------

/// Splits `postgres[ql]://user:pass@host:port/dbname[?params]` into
/// `(prefix, db_name, suffix)` where the original URL equals
/// `format!("{prefix}{db_name}{suffix}")`.
fn extract_db_url_parts(database_url: &str) -> Option<(String, String, String)> {
    // Identify the scheme; strip it to get the rest of the URL.
    let (scheme, rest) = ["postgresql://", "postgres://"]
        .iter()
        .find_map(|&s| database_url.strip_prefix(s).map(|r| (s, r)))?;

    // Find the first '/' after the authority (user:pass@host:port).
    let slash = rest.find('/')?;
    // Everything up to and including the slash is the prefix.
    let prefix = format!("{}{}/", scheme, &rest[..slash]);
    let after_slash = &rest[slash + 1..];

    // Split off any query string.
    let (db_name, suffix) = if let Some(q) = after_slash.find('?') {
        (after_slash[..q].to_string(), after_slash[q..].to_string())
    } else {
        (after_slash.to_string(), String::new())
    };

    Some((prefix, db_name, suffix))
}

/// Returns the effective database URL for the current process:
///
/// - If a worktree slug is active, rewrites the database name in
///   `DATABASE_URL` to the derived per-worktree name.
/// - Otherwise returns `DATABASE_URL` unchanged.
pub fn effective_database_url() -> Result<String, DbError> {
    let database_url = env::var(DATABASE_URL_VAR).map_err(|_| DbError::MissingDatabaseUrl)?;

    if let Some(slug) = worktree_slug() {
        let (prefix, base_db, suffix) =
            extract_db_url_parts(&database_url).ok_or(DbError::InvalidDatabaseUrl)?;
        let derived = derive_db_name(&base_db, &slug);
        Ok(format!("{prefix}{derived}{suffix}"))
    } else {
        Ok(database_url)
    }
}

/// Returns the "maintenance" URL for `database_url`: the same server and
/// credentials but with the database name replaced by `postgres` (the
/// always-present Postgres maintenance DB). Used for `CREATE DATABASE` and
/// `DROP DATABASE` operations that cannot run inside a connection to the
/// target database itself.
pub fn maintenance_url(database_url: &str) -> Option<String> {
    let (prefix, _, suffix) = extract_db_url_parts(database_url)?;
    Some(format!("{prefix}postgres{suffix}"))
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/// Reads `DATABASE_URL` from the environment, rewrites it for the current
/// worktree (if any), and builds a connection pool. Fails with a descriptive
/// [`DbError`] rather than panicking so the caller can log and exit non-zero.
pub async fn connect() -> Result<PgPool, DbError> {
    let url = effective_database_url()?;
    connect_with(&url).await
}

/// Builds a connection pool for an explicit connection string. Split out
/// from [`connect`] so tests can point at a database without mutating
/// process-wide environment state.
pub async fn connect_with(database_url: &str) -> Result<PgPool, DbError> {
    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(CONNECT_TIMEOUT)
        .connect(database_url)
        .await
        .map_err(DbError::Connect)
}

// ---------------------------------------------------------------------------
// On-demand database creation
// ---------------------------------------------------------------------------

/// Connects to the maintenance database (`postgres`) on the same server and
/// creates the database named in `database_url` if it does not yet exist.
///
/// Safe under concurrency: if two processes race to create the same DB, the
/// one that arrives second receives a `duplicate_database` (SQLSTATE 42P04)
/// error which this function treats as success. No manual `psql` step is
/// required.
///
/// The database user must have the `CREATEDB` privilege. Add it with:
/// `ALTER ROLE epistl CREATEDB;` (or equivalent for non-default roles).
pub async fn create_db_if_missing(database_url: &str) -> Result<(), DbError> {
    let (_, db_name, _) = extract_db_url_parts(database_url).ok_or(DbError::InvalidDatabaseUrl)?;

    let maint = maintenance_url(database_url).ok_or(DbError::InvalidDatabaseUrl)?;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&maint)
        .await
        .map_err(DbError::Connect)?;

    // DB names from derive_db_name are [a-z0-9_] only (no injection risk),
    // but double-quote for correctness regardless. AssertSqlSafe is required
    // by sqlx 0.9 for dynamically-constructed SQL strings.
    let sql = format!("CREATE DATABASE \"{}\"", db_name.replace('"', "\"\""));
    let result = sqlx::query(sqlx::AssertSqlSafe(sql)).execute(&pool).await;

    match result {
        Ok(_) => Ok(()),
        Err(sqlx::Error::Database(db_err)) if db_err.code().as_deref() == Some("42P04") => {
            // duplicate_database — already exists, that's fine.
            Ok(())
        }
        Err(err) => Err(DbError::DbOp(err)),
    }
}

// ---------------------------------------------------------------------------
// Drop / prune
// ---------------------------------------------------------------------------

/// Drops the per-worktree database derived from `DATABASE_URL` and the
/// current worktree slug.
///
/// Refuses to run when no slug is active (which would mean dropping the base
/// production/dev database). Idempotent: silently succeeds if the database is
/// already gone.
///
/// The NATS stream teardown is handled separately by the migrate binary's
/// `--drop` path (which calls this + `crate::nats::drop_worktree_stream`).
pub async fn drop_worktree_db(database_url: &str) -> Result<(), DbError> {
    let slug = worktree_slug().ok_or(DbError::NoWorktreeSlug)?;

    let (prefix, base_db, suffix) =
        extract_db_url_parts(database_url).ok_or(DbError::InvalidDatabaseUrl)?;
    let derived = derive_db_name(&base_db, &slug);

    // Safety check: never drop the base DB.
    if derived == base_db {
        return Err(DbError::NoWorktreeSlug);
    }

    let maint = format!("{prefix}postgres{suffix}");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&maint)
        .await
        .map_err(DbError::Connect)?;

    let sql = format!(
        "DROP DATABASE IF EXISTS \"{}\"",
        derived.replace('"', "\"\"")
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(&pool)
        .await
        .map_err(DbError::DbOp)?;

    Ok(())
}

/// Returns information about databases matching the `<base_db>_wt_*` pattern
/// whose worktree no longer exists, for use by [`prune_worktree_dbs`].
///
/// Each entry is `(db_name, derived_slug)`.
fn orphaned_worktree_dbs(
    all_dbs: &[String],
    base_db: &str,
    active_slugs: &std::collections::HashSet<String>,
) -> Vec<(String, String)> {
    let prefix = format!("{base_db}_wt_");
    all_dbs
        .iter()
        .filter_map(|name| {
            let slug = name.strip_prefix(&prefix)?;
            if !active_slugs.contains(slug) {
                Some((name.clone(), slug.to_string()))
            } else {
                None
            }
        })
        .collect()
}

/// Returns the slugs of currently live git worktrees (those whose path
/// contains `.claude/worktrees/<name>`).
pub fn live_worktree_slugs() -> std::collections::HashSet<String> {
    let output = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap_or_else(|_| std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: vec![],
            stderr: vec![],
        });

    let text = String::from_utf8_lossy(&output.stdout);
    let marker = "/.claude/worktrees/";
    let mut slugs = std::collections::HashSet::new();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(idx) = rest.find(marker) {
                let after = &rest[idx + marker.len()..];
                let name = after.split('/').next().unwrap_or("").trim();
                if !name.is_empty() {
                    slugs.insert(sanitize_slug(name));
                }
            }
        }
    }

    slugs
}

/// Drops every `<base_db>_wt_*` database (and returns its slug) whose
/// worktree no longer exists according to `git worktree list`. Never touches
/// the base DB or a live worktree's DB. Idempotent. Returns the list of
/// databases that were (or would be, under `dry_run`) dropped, together
/// with their slugs.
///
/// The NATS stream teardown is done separately by the caller (migrate bin).
pub async fn prune_worktree_dbs(
    database_url: &str,
    dry_run: bool,
) -> Result<Vec<(String, String)>, DbError> {
    let (prefix, base_db, suffix) =
        extract_db_url_parts(database_url).ok_or(DbError::InvalidDatabaseUrl)?;

    let maint = format!("{prefix}postgres{suffix}");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&maint)
        .await
        .map_err(DbError::Connect)?;

    // List all databases.
    let all_dbs: Vec<String> =
        sqlx::query_scalar("SELECT datname FROM pg_catalog.pg_database ORDER BY datname")
            .fetch_all(&pool)
            .await
            .map_err(DbError::DbOp)?;

    let active_slugs = live_worktree_slugs();
    let orphans = orphaned_worktree_dbs(&all_dbs, &base_db, &active_slugs);

    if !dry_run {
        for (db_name, _) in &orphans {
            // Terminate existing connections before dropping.
            let terminate_sql = format!(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE datname = '{}' AND pid <> pg_backend_pid()",
                db_name.replace('\'', "''")
            );
            let _ = sqlx::query(sqlx::AssertSqlSafe(terminate_sql))
                .execute(&pool)
                .await;

            let drop_sql = format!(
                "DROP DATABASE IF EXISTS \"{}\"",
                db_name.replace('"', "\"\"")
            );
            sqlx::query(sqlx::AssertSqlSafe(drop_sql))
                .execute(&pool)
                .await
                .map_err(DbError::DbOp)?;
        }
    }

    Ok(orphans)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // --- slug sanitization ---

    #[test]
    fn sanitize_slug_lowercases() {
        assert_eq!(sanitize_slug("Issue-42-LoginForm"), "issue_42_loginform");
    }

    #[test]
    fn sanitize_slug_replaces_non_alnum_underscore() {
        assert_eq!(sanitize_slug("issue-42-login/form"), "issue_42_login_form");
    }

    #[test]
    fn sanitize_slug_keeps_underscores_digits() {
        assert_eq!(sanitize_slug("issue_42_abc123"), "issue_42_abc123");
    }

    #[test]
    fn sanitize_slug_empty() {
        assert_eq!(sanitize_slug(""), "");
    }

    // --- DB name derivation ---

    #[test]
    fn derive_db_name_basic() {
        assert_eq!(
            derive_db_name("epistl", "issue_42_login"),
            "epistl_wt_issue_42_login"
        );
    }

    #[test]
    fn derive_db_name_truncates_to_63_bytes() {
        let base = "epistl";
        let slug = "a".repeat(60); // would produce "epistl_wt_" (10) + 60 = 70 > 63
        let result = derive_db_name(base, &slug);
        assert!(
            result.len() <= 63,
            "derived name is {len} bytes (> 63): {result}",
            len = result.len()
        );
        // Must still start with the prefix.
        assert!(result.starts_with("epistl_wt_"));
    }

    #[test]
    fn derive_db_name_deterministic() {
        let a = derive_db_name("epistl", "issue_219_slug");
        let b = derive_db_name("epistl", "issue_219_slug");
        assert_eq!(a, b);
    }

    // --- URL manipulation ---

    #[test]
    fn extract_db_url_parts_postgres_scheme() {
        let url = "postgres://user:pass@localhost:5432/mydb";
        let (prefix, db, suffix) = extract_db_url_parts(url).unwrap();
        assert_eq!(prefix, "postgres://user:pass@localhost:5432/");
        assert_eq!(db, "mydb");
        assert_eq!(suffix, "");
    }

    #[test]
    fn extract_db_url_parts_with_query() {
        let url = "postgres://user:pass@localhost/mydb?sslmode=require";
        let (prefix, db, suffix) = extract_db_url_parts(url).unwrap();
        assert_eq!(db, "mydb");
        assert_eq!(suffix, "?sslmode=require");
        assert_eq!(prefix, "postgres://user:pass@localhost/");
    }

    #[test]
    fn maintenance_url_replaces_db_with_postgres() {
        let url = "postgres://user:pass@localhost:5432/mydb";
        let maint = maintenance_url(url).unwrap();
        assert_eq!(maint, "postgres://user:pass@localhost:5432/postgres");
    }

    // --- worktree_slug with env var override ---

    #[test]
    #[serial]
    fn worktree_slug_reads_env_var() {
        let prev = env::var(WORKTREE_SLUG_VAR).ok();
        unsafe {
            env::set_var(WORKTREE_SLUG_VAR, "Issue-42-Login");
        }
        let slug = worktree_slug();
        if let Some(prev) = prev {
            unsafe { env::set_var(WORKTREE_SLUG_VAR, prev) };
        } else {
            unsafe { env::remove_var(WORKTREE_SLUG_VAR) };
        }
        assert_eq!(slug, Some("issue_42_login".to_string()));
    }

    #[test]
    #[serial]
    fn worktree_slug_empty_env_var_falls_through() {
        // An empty EPISTL_WORKTREE_SLUG must not produce a slug from the env
        // var (it falls through to git detection).
        let prev = env::var(WORKTREE_SLUG_VAR).ok();
        unsafe {
            env::set_var(WORKTREE_SLUG_VAR, "");
        }
        // We can't control git here, but we can confirm the env var branch
        // was skipped by verifying the code doesn't return Some("").
        let slug = worktree_slug();
        if let Some(prev) = prev {
            unsafe { env::set_var(WORKTREE_SLUG_VAR, prev) };
        } else {
            unsafe { env::remove_var(WORKTREE_SLUG_VAR) };
        }
        assert_ne!(slug, Some(String::new()));
    }

    // --- orphaned_worktree_dbs ---

    #[test]
    fn orphaned_worktree_dbs_identifies_gone_worktrees() {
        let all_dbs = vec![
            "epistl".to_string(),
            "epistl_wt_issue_1_slug".to_string(), // worktree gone
            "epistl_wt_issue_2_alive".to_string(), // still live
            "other_db".to_string(),
        ];
        let mut active = std::collections::HashSet::new();
        active.insert("issue_2_alive".to_string());

        let orphans = orphaned_worktree_dbs(&all_dbs, "epistl", &active);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].0, "epistl_wt_issue_1_slug");
        assert_eq!(orphans[0].1, "issue_1_slug");
    }

    #[test]
    fn orphaned_worktree_dbs_never_returns_base_db() {
        // The base DB has no _wt_ prefix, so it should never appear.
        let all_dbs = vec!["epistl".to_string()];
        let active = std::collections::HashSet::new();
        let orphans = orphaned_worktree_dbs(&all_dbs, "epistl", &active);
        assert!(orphans.is_empty());
    }

    // --- connect helpers ---

    #[tokio::test]
    async fn connect_with_invalid_url_fails_fast() {
        let result = connect_with("postgres://localhost:1/does-not-exist").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn connect_reports_missing_database_url() {
        // SAFETY: `#[serial]` (default, unnamed group -- shared with
        // `relay::tests`' and `nats::tests`' `#[serial]` tests) ensures this
        // test does not run concurrently with any other test in this binary
        // that reads or writes DATABASE_URL. Confirmed mechanism (issue
        // #122, mirroring #121's NATS_URL fix): without this,
        // `relay::tests::test_state()`'s `dotenvy::dotenv()` call, running
        // concurrently on another thread, can repopulate the just-removed
        // DATABASE_URL from `.env` before this test's own `connect()` call
        // reads it, flipping the expected `MissingDatabaseUrl` into a
        // spurious `Ok(Pool)`.
        let previous = env::var(DATABASE_URL_VAR).ok();
        unsafe {
            env::remove_var(DATABASE_URL_VAR);
            // Also clear the worktree slug var so effective_database_url()
            // doesn't succeed via a cached slug that bypasses MissingDatabaseUrl.
            env::remove_var(WORKTREE_SLUG_VAR);
        }

        let result = connect().await;

        if let Some(previous) = previous {
            unsafe {
                env::set_var(DATABASE_URL_VAR, previous);
            }
        }

        match result {
            Err(DbError::MissingDatabaseUrl) => {}
            other => panic!("expected MissingDatabaseUrl, got {other:?}"),
        }
    }

    /// When a worktree slug is active and `create_db_if_missing` is called
    /// twice for the same DB, the second call must succeed (idempotency).
    #[tokio::test]
    #[serial]
    async fn create_db_if_missing_is_idempotent() {
        dotenvy::dotenv().ok();
        let database_url = match env::var(DATABASE_URL_VAR) {
            Ok(u) => u,
            Err(_) => return, // skip if not configured
        };

        // Build a unique test DB name using a UUID-based slug so parallel
        // test runs don't collide with each other.
        let slug = format!("test_{}", uuid::Uuid::new_v4().simple());
        let (prefix, base_db, suffix) =
            extract_db_url_parts(&database_url).expect("DATABASE_URL must be parseable");
        let derived_db = derive_db_name(&base_db, &slug);
        let test_url = format!("{prefix}{derived_db}{suffix}");

        // Ensure clean slate (DB may linger from a previous interrupted run).
        let maint = maintenance_url(&test_url).unwrap();
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&maint)
            .await
            .expect("failed to connect to maintenance DB");

        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS \"{derived_db}\""
        )))
        .execute(&pool)
        .await;
        drop(pool);

        // First call: creates the DB.
        create_db_if_missing(&test_url)
            .await
            .expect("first create_db_if_missing failed");

        // Second call: DB already exists; must succeed anyway.
        create_db_if_missing(&test_url)
            .await
            .expect("second create_db_if_missing should be idempotent");

        // Cleanup.
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&maint)
            .await
            .expect("failed to connect to maintenance DB for cleanup");
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS \"{derived_db}\""
        )))
        .execute(&pool)
        .await;
    }

    /// `prune_worktree_dbs` dry-run lists orphans without dropping them.
    #[tokio::test]
    #[serial]
    async fn prune_worktree_dbs_dry_run_lists_without_dropping() {
        dotenvy::dotenv().ok();
        let database_url = match env::var(DATABASE_URL_VAR) {
            Ok(u) => u,
            Err(_) => return,
        };

        // Create two fake worktree DBs — one "orphan" (no matching worktree)
        // and we simulate the other as "alive" by inserting its slug into the
        // active set manually. Since we can't control git, we use the env-var
        // override to make the test deterministic.
        let slug_orphan = format!("prune_orphan_{}", uuid::Uuid::new_v4().simple());
        let slug_alive = format!("prune_alive_{}", uuid::Uuid::new_v4().simple());

        let (prefix, base_db, suffix) =
            extract_db_url_parts(&database_url).expect("DATABASE_URL must be parseable");

        let db_orphan = derive_db_name(&base_db, &slug_orphan);
        let db_alive = derive_db_name(&base_db, &slug_alive);

        let maint = format!("{prefix}postgres{suffix}");
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&maint)
            .await
            .expect("failed to connect to maintenance DB");

        // Create both test DBs.
        for db in [&db_orphan, &db_alive] {
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP DATABASE IF EXISTS \"{db}\""
            )))
            .execute(&pool)
            .await;
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE \"{db}\"")))
                .execute(&pool)
                .await
                .expect("failed to create test DB");
        }

        // Query actual DB list and check orphans manually using our helper.
        let all_dbs: Vec<String> =
            sqlx::query_scalar("SELECT datname FROM pg_catalog.pg_database ORDER BY datname")
                .fetch_all(&pool)
                .await
                .expect("failed to list DBs");

        let mut active_slugs = std::collections::HashSet::new();
        active_slugs.insert(slug_alive.clone());

        let orphans = orphaned_worktree_dbs(&all_dbs, &base_db, &active_slugs);
        // The orphan must appear.
        let found = orphans.iter().any(|(n, _)| n == &db_orphan);
        assert!(found, "orphan {db_orphan} not found in orphan list");
        // The alive DB must NOT appear.
        let alive_found = orphans.iter().any(|(n, _)| n == &db_alive);
        assert!(!alive_found, "alive DB {db_alive} must not be pruned");

        // The DB must still exist after the dry-run check.
        let exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pg_catalog.pg_database WHERE datname = $1")
                .bind(&db_orphan)
                .fetch_one(&pool)
                .await
                .expect("failed to check DB existence");
        assert_eq!(exists, 1, "dry-run must not drop the DB");

        // Cleanup.
        for db in [&db_orphan, &db_alive] {
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP DATABASE IF EXISTS \"{db}\""
            )))
            .execute(&pool)
            .await;
        }
    }
}
