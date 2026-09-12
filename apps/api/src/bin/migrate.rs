//! Standalone migration runner.
//!
//! Applies the SQL migrations in `apps/api/migrations` to the database at
//! `DATABASE_URL`. Used in CI (which sets `DATABASE_URL` directly as a job
//! env var) and locally against the `docker-compose.yml` Postgres instance,
//! where `DATABASE_URL` is picked up automatically from a repo-root `.env`
//! (see `.env.example`) via `dotenvy` -- just run:
//!
//! ```sh
//! moon run api:migrate
//! ```
//!
//! Re-running against an already-migrated database is a no-op: sqlx tracks
//! applied migrations in a `_sqlx_migrations` table.

use std::time::Duration;

use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() {
    // See apps/api/src/main.rs for why this is safe to call unconditionally
    // (never overrides an already-set var; no-op if no .env is found).
    dotenvy::dotenv().ok();

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        eprintln!("DATABASE_URL must be set to run migrations");
        std::process::exit(1);
    });

    let pool = match PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
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

    println!("migrations applied");
}
