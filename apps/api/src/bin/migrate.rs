//! Standalone migration runner.
//!
//! Applies the SQL migrations in `apps/api/migrations` to the database at
//! `DATABASE_URL`. Used in CI (before `cargo test`) and can be run locally
//! against the `docker-compose.yml` Postgres instance:
//!
//! ```sh
//! DATABASE_URL=postgres://epistl:epistl@localhost:5432/epistl \
//!   cargo run --manifest-path apps/api/Cargo.toml --bin migrate
//! ```
//!
//! Re-running against an already-migrated database is a no-op: sqlx tracks
//! applied migrations in a `_sqlx_migrations` table.

use std::time::Duration;

use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() {
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
