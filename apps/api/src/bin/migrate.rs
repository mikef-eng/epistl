//! Standalone migration runner with per-worktree database isolation.
//!
//! Applies the SQL migrations in `apps/api/migrations` to the effective
//! database (derived from `DATABASE_URL` + the current worktree slug, if
//! any -- see `api::db::effective_database_url` and
//! `docs/architecture/overview.md`). Used in CI and locally:
//!
//! ```sh
//! moon run api:migrate          # normal run: create-if-missing + migrations
//! moon run api:db-drop          # drop current worktree's DB + NATS stream
//! moon run api:db-prune         # drop orphaned worktree DBs + streams
//! moon run api:db-prune -- --dry-run   # list without dropping
//! ```
//!
//! Re-running against an already-migrated database is a no-op: sqlx tracks
//! applied migrations in a `_sqlx_migrations` table.
//!
//! On the primary checkout (no worktree slug), `moon run api:migrate`
//! behaves exactly as before: it connects to the database named in
//! `DATABASE_URL` and runs migrations there.

use std::time::Duration;

use async_nats::jetstream;
use sqlx::postgres::PgPoolOptions;

/// Parses a very small CLI: `[--drop] [--prune [--dry-run]]`.
struct Flags {
    drop: bool,
    prune: bool,
    dry_run: bool,
}

impl Flags {
    fn parse() -> Self {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let drop = args.contains(&"--drop".to_string());
        let prune = args.contains(&"--prune".to_string());
        let dry_run = args.contains(&"--dry-run".to_string());
        Flags {
            drop,
            prune,
            dry_run,
        }
    }
}

#[tokio::main]
async fn main() {
    // See apps/api/src/main.rs for why this is safe to call unconditionally
    // (never overrides an already-set var; no-op if no .env is found).
    dotenvy::dotenv().ok();

    let flags = Flags::parse();

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        eprintln!("DATABASE_URL must be set to run migrations");
        std::process::exit(1);
    });

    if flags.drop {
        run_drop(&database_url).await;
        return;
    }

    if flags.prune {
        run_prune(&database_url, flags.dry_run).await;
        return;
    }

    run_migrate().await;
}

// ---------------------------------------------------------------------------
// Migrate (normal path)
// ---------------------------------------------------------------------------

async fn run_migrate() {
    // Derive the effective URL for this worktree (or use DATABASE_URL as-is
    // on the primary checkout).
    let effective_url = match api::db::effective_database_url() {
        Ok(url) => url,
        Err(err) => {
            eprintln!("failed to derive effective database URL: {err}");
            std::process::exit(1);
        }
    };

    // On-demand creation: connect to the maintenance DB and CREATE DATABASE
    // if the target doesn't exist yet. Safe under concurrency.
    if let Err(err) = api::db::create_db_if_missing(&effective_url).await {
        eprintln!("failed to create database: {err}");
        std::process::exit(1);
    }

    let pool = match PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&effective_url)
        .await
    {
        Ok(pool) => pool,
        Err(err) => {
            eprintln!("failed to connect to Postgres: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = sqlx::migrate!("./migrations").run(&pool).await {
        eprintln!("failed to run migrations: {err}");
        std::process::exit(1);
    }

    // Print the effective DB so it's visible in moon logs.
    let db_name = effective_url.rsplit('/').next().unwrap_or(&effective_url);
    println!("migrations applied to {db_name}");

    // Ensure the offline-delivery NATS stream is ready for the effective
    // worktree context (idempotent: does nothing if the stream already
    // exists with the right config).
    ensure_nats_stream_if_configured().await;
}

async fn ensure_nats_stream_if_configured() {
    let nats_url = match std::env::var(api::nats::NATS_URL_VAR) {
        Ok(url) => url,
        Err(_) => return, // NATS_URL not set — skip silently
    };
    let client = match async_nats::connect(&nats_url).await {
        Ok(c) => c,
        Err(_) => return, // NATS not reachable — skip silently
    };
    let js = jetstream::new(client);
    let _ = api::nats::ensure_offline_stream(&js).await;
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

async fn run_drop(database_url: &str) {
    if api::db::worktree_slug().is_none() {
        eprintln!(
            "error: --drop refuses to run without an active worktree slug.\n\
             Set EPISTL_WORKTREE_SLUG or run from inside a .claude/worktrees/<name> checkout."
        );
        std::process::exit(1);
    }

    // Drop DB.
    match api::db::drop_worktree_db(database_url).await {
        Ok(()) => {}
        Err(err) => {
            eprintln!("failed to drop worktree DB: {err}");
            std::process::exit(1);
        }
    }

    // Drop NATS stream.
    if let Ok(nats_url) = std::env::var(api::nats::NATS_URL_VAR) {
        if let Ok(client) = async_nats::connect(&nats_url).await {
            let js = jetstream::new(client);
            api::nats::drop_worktree_stream(&js).await;
        }
    }

    let slug = api::db::worktree_slug().unwrap_or_default();
    println!("dropped worktree DB and NATS stream for slug: {slug}");
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

async fn run_prune(database_url: &str, dry_run: bool) {
    if dry_run {
        println!("dry-run: listing orphaned worktree databases (nothing will be dropped)");
    }

    // Prune DBs.
    let orphan_dbs = match api::db::prune_worktree_dbs(database_url, dry_run).await {
        Ok(dbs) => dbs,
        Err(err) => {
            eprintln!("failed to prune worktree DBs: {err}");
            std::process::exit(1);
        }
    };

    for (db_name, slug) in &orphan_dbs {
        if dry_run {
            println!("  would drop DB: {db_name} (slug: {slug})");
        } else {
            println!("  dropped DB: {db_name} (slug: {slug})");
        }
    }

    // Prune NATS streams for the same orphaned slugs.
    if let Ok(nats_url) = std::env::var(api::nats::NATS_URL_VAR) {
        if let Ok(client) = async_nats::connect(&nats_url).await {
            use api::db::live_worktree_slugs;
            let js = jetstream::new(client);
            let active_slugs = live_worktree_slugs();
            let orphan_streams = api::nats::orphaned_worktree_streams(&js, &active_slugs).await;
            for stream_name in &orphan_streams {
                if dry_run {
                    println!("  would drop NATS stream: {stream_name}");
                } else {
                    let _ = js.delete_stream(stream_name).await;
                    println!("  dropped NATS stream: {stream_name}");
                }
            }
        }
    }

    if orphan_dbs.is_empty() {
        println!("no orphaned worktree databases found");
    } else if dry_run {
        println!(
            "dry-run complete: {} database(s) would be dropped",
            orphan_dbs.len()
        );
    } else {
        println!("pruned {} orphaned worktree database(s)", orphan_dbs.len());
    }
}
