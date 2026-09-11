//! Database connection setup.
//!
//! Postgres is the app's only relational store. It holds users, sessions,
//! accounts, and verifications (all driven by the `better-auth` crate --
//! see `crate::auth`), plus contacts. No message content or PQC key
//! material is ever stored here.

use std::env;
use std::fmt;
use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

/// How long to wait for the initial connection before giving up. Kept short
/// so startup fails fast instead of hanging for sqlx's 30s default.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Environment variable read for the Postgres connection string.
pub const DATABASE_URL_VAR: &str = "DATABASE_URL";

/// Errors that can occur while building the database connection pool at
/// startup.
#[derive(Debug)]
pub enum DbError {
    /// `DATABASE_URL` was not set (or was not valid UTF-8) in the
    /// environment.
    MissingDatabaseUrl,
    /// The pool could not connect to the configured database.
    Connect(sqlx::Error),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::MissingDatabaseUrl => {
                write!(f, "{DATABASE_URL_VAR} must be set to connect to Postgres")
            }
            DbError::Connect(err) => write!(f, "failed to connect to Postgres: {err}"),
        }
    }
}

impl std::error::Error for DbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DbError::MissingDatabaseUrl => None,
            DbError::Connect(err) => Some(err),
        }
    }
}

/// Reads `DATABASE_URL` from the environment and builds a connection pool,
/// failing with a descriptive [`DbError`] rather than panicking so the
/// caller can log the problem and exit non-zero.
pub async fn connect() -> Result<PgPool, DbError> {
    let database_url = env::var(DATABASE_URL_VAR).map_err(|_| DbError::MissingDatabaseUrl)?;
    connect_with(&database_url).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_with_invalid_url_fails_fast() {
        let result = connect_with("postgres://localhost:1/does-not-exist").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connect_reports_missing_database_url() {
        // SAFETY: this test does not run concurrently with other tests that
        // read/write DATABASE_URL; sqlx's own env access happens per-call.
        let previous = env::var(DATABASE_URL_VAR).ok();
        unsafe {
            env::remove_var(DATABASE_URL_VAR);
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
}
