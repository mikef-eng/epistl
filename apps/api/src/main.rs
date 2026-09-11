use api::auth::{self, AppState};
use api::db;

/// Environment variable read for the Better Auth signing secret. Must be at
/// least 32 bytes; `better-auth` itself enforces this at build time.
const AUTH_SECRET_VAR: &str = "AUTH_SECRET";

#[tokio::main]
async fn main() {
    let database_url = match env_database_url() {
        Ok(url) => url,
        Err(err) => {
            eprintln!("startup failed: {err}");
            std::process::exit(1);
        }
    };

    // Fail fast with a clear message if we can't reach Postgres; the app
    // has nothing useful to do without it. This pool backs tables the app
    // owns outright (e.g. `contacts`) rather than tables mediated through
    // `better-auth`'s own SeaORM connection below.
    let pool = match db::connect().await {
        Ok(pool) => pool,
        Err(err) => {
            eprintln!("startup failed: {err}");
            std::process::exit(1);
        }
    };

    let secret = match std::env::var(AUTH_SECRET_VAR) {
        Ok(secret) => secret,
        Err(_) => {
            eprintln!("startup failed: {AUTH_SECRET_VAR} must be set (at least 32 bytes)");
            std::process::exit(1);
        }
    };

    let auth = match auth::build_auth(&database_url, &secret).await {
        Ok(auth) => auth,
        Err(err) => {
            eprintln!("startup failed: {err}");
            std::process::exit(1);
        }
    };

    let app = api::app(AppState { auth, pool });
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("failed to bind listener");
    axum::serve(listener, app).await.expect("server error");
}

fn env_database_url() -> Result<String, String> {
    std::env::var(db::DATABASE_URL_VAR).map_err(|_| format!("{} must be set", db::DATABASE_URL_VAR))
}
