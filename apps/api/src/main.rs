#[tokio::main]
async fn main() {
    // Fail fast with a clear message if we can't reach Postgres; the app
    // has nothing useful to do without it.
    let pool = match api::db::connect().await {
        Ok(pool) => pool,
        Err(err) => {
            eprintln!("startup failed: {err}");
            std::process::exit(1);
        }
    };

    let app = api::app(pool);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("failed to bind listener");
    axum::serve(listener, app).await.expect("server error");
}
