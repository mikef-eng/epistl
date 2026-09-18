//! Integration test proving the `users` / `contacts` schema round-trips
//! against a real Postgres instance.
//!
//! Requires `DATABASE_URL` to point at a reachable Postgres (see
//! `docker-compose.yml` for local dev, or the `postgres:16` CI service).

use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use uuid::Uuid;

async fn connect() -> sqlx::PgPool {
    // Loads DATABASE_URL from a repo-root .env if present and not already
    // set (e.g. by CI). Safe to call redundantly per-test.
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set to run this integration test");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("failed to run migrations");

    pool
}

#[tokio::test]
async fn user_and_contact_rows_round_trip() {
    let pool = connect().await;

    // Unique emails per run so this test can be re-run against a
    // persistent dev database without hitting the UNIQUE constraint.
    let run_id = Uuid::new_v4();
    let owner_email = format!("owner-{run_id}@example.com");
    let contact_email = format!("contact-{run_id}@example.com");
    let owner_username = Uuid::new_v4().simple().to_string();
    let contact_username = Uuid::new_v4().simple().to_string();

    let owner_id: Uuid =
        sqlx::query("INSERT INTO users (email, username) VALUES ($1, $2) RETURNING id")
            .bind(&owner_email)
            .bind(&owner_username)
            .fetch_one(&pool)
            .await
            .expect("failed to insert owner user")
            .get("id");

    let contact_user_id: Uuid =
        sqlx::query("INSERT INTO users (email, username) VALUES ($1, $2) RETURNING id")
            .bind(&contact_email)
            .bind(&contact_username)
            .fetch_one(&pool)
            .await
            .expect("failed to insert contact user")
            .get("id");

    let contact_id: Uuid = sqlx::query(
        "INSERT INTO contacts (owner_user_id, contact_user_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(owner_id)
    .bind(contact_user_id)
    .fetch_one(&pool)
    .await
    .expect("failed to insert contact")
    .get("id");

    let user_row = sqlx::query("SELECT email FROM users WHERE id = $1")
        .bind(owner_id)
        .fetch_one(&pool)
        .await
        .expect("failed to read back owner user");
    assert_eq!(user_row.get::<String, _>("email"), owner_email);

    let contact_row =
        sqlx::query("SELECT owner_user_id, contact_user_id FROM contacts WHERE id = $1")
            .bind(contact_id)
            .fetch_one(&pool)
            .await
            .expect("failed to read back contact");
    assert_eq!(contact_row.get::<Uuid, _>("owner_user_id"), owner_id);
    assert_eq!(
        contact_row.get::<Uuid, _>("contact_user_id"),
        contact_user_id
    );
}
