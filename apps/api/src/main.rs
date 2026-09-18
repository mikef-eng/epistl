use api::auth::{self, AppState};
use api::db;
use api::nats;

/// Environment variable read for the Better Auth signing secret. Must be at
/// least 32 bytes; `better-auth` itself enforces this at build time.
const AUTH_SECRET_VAR: &str = "AUTH_SECRET";

#[tokio::main]
async fn main() {
    // Loads .env (walking up from the cwd, so this finds the repo-root
    // .env regardless of whether this runs via `cargo run` from apps/api
    // or `moon run api:dev` from the repo root) into the process
    // environment. Never overrides a var that's already set, so CI's own
    // job-level env: values always win over a stray .env if one exists.
    // Silently a no-op if no .env file is found (e.g. in CI).
    dotenvy::dotenv().ok();

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

    // Fail fast the same way as the Postgres pool above: the offline-
    // delivery queue built out in later issues in this batch depends on a
    // reachable NATS server, so there's nothing useful the app can do
    // without one.
    let nats_client = match nats::connect().await {
        Ok(client) => client,
        Err(err) => {
            eprintln!("startup failed: {err}");
            std::process::exit(1);
        }
    };

    // Fail fast the same way: the offline-delivery queue is a fixed part
    // of the app's contract with itself (see ADR 0008), so an
    // unconfigurable JetStream is as fatal as an unreachable NATS server.
    let jetstream = async_nats::jetstream::new(nats_client.clone());
    if let Err(err) = nats::ensure_offline_stream(&jetstream).await {
        eprintln!("startup failed: {err}");
        std::process::exit(1);
    }

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

    // Fail fast the same way as Postgres/NATS above: every avatar
    // upload/serving route depends on a fully configured SeaweedFS client
    // pair (issue #189), so a missing env var is as fatal as an
    // unreachable database.
    let avatar_store = match api::avatars::AvatarStore::from_env() {
        Ok(avatar_store) => avatar_store,
        Err(err) => {
            eprintln!("startup failed: {err}");
            std::process::exit(1);
        }
    };

    let state = AppState {
        auth,
        pool,
        registry: api::registry::ConnectionRegistry::new(),
        nats: nats_client,
        search_rate_limiter: api::search::SearchRateLimiter::new(),
        push_notifier: std::sync::Arc::new(api::push::ExpoPushNotifier::new()),
        avatar_store,
    };

    // On by default (issue #114): starts a real QUIC listener alongside
    // HTTP/WS, binding `QUIC_LISTEN_ADDR` if set or else
    // `api::quic::DEFAULT_LISTEN_ADDR`; a no-op only if `QUIC_LISTEN_ADDR`
    // is explicitly set to `api::quic::DISABLE_VALUE`. Failing fast on a
    // misconfigured address mirrors the Postgres/NATS checks above -- a
    // listener that silently never started would be worse than a loud
    // startup failure.
    if let Err(err) = api::quic::maybe_spawn(state.clone()).await {
        eprintln!("startup failed: {err}");
        std::process::exit(1);
    }

    let app = api::app(state);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("failed to bind listener");
    axum::serve(listener, app).await.expect("server error");
}

fn env_database_url() -> Result<String, String> {
    std::env::var(db::DATABASE_URL_VAR).map_err(|_| format!("{} must be set", db::DATABASE_URL_VAR))
}
