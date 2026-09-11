//! Signup, login, and session validation backed by the real `better-auth`
//! crate (feature = "seaorm2"), against the `users` / `sessions` / `accounts`
//! / `verifications` tables owned by this app's sqlx migrations.
//!
//! Better Auth's SeaORM integration is schema-agnostic: the app defines its
//! own SeaORM entities matching its own tables, and implements the
//! `AuthUser` / `AuthSession` / `AuthAccount` / `AuthVerification` traits
//! (plus their `SeaOrm*Model` counterparts) so the framework can read and
//! write through them. See `apps/api/migrations/0004_reconcile_better_auth_schema.sql`
//! for the additive schema this required beyond issue #1's `0001`/`0002`.
//!
//! This module intentionally does not expose Better Auth's own
//! `/sign-up/email` / `/sign-in/email` HTTP surface (mounted via
//! `auth.axum_router_with_state`) because its default status codes and
//! response shapes don't match this issue's acceptance criteria (200 vs
//! 201 on signup, `422` vs `409` on duplicate email, etc). Instead, thin
//! `/signup` and `/login` handlers dispatch into the real
//! `EmailPasswordPlugin` via `BetterAuth::handle_request` and translate its
//! response into this app's contract.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use better_auth::plugins::EmailPasswordPlugin;
use better_auth::prelude::{
    AuthAccount, AuthRequest, AuthSession, AuthUser, AuthVerification, CreateAccount,
    CreateSession, CreateUser, CreateVerification, HttpMethod, UpdateAccount, UpdateUser,
};
use better_auth::seaorm::sea_orm;
use better_auth::seaorm::sea_orm::entity::prelude::*;
use better_auth::seaorm::sea_orm::ActiveValue::Set;
use better_auth::seaorm::{
    Database, DatabaseConnection, SeaOrmAccountModel, SeaOrmSessionModel, SeaOrmStore,
    SeaOrmUserModel, SeaOrmVerificationModel,
};
use better_auth::{AuthConfig, AuthError, AuthResult, AuthSchema, BetterAuth};

// ---------------------------------------------------------------------------
// Entities -- these map onto the tables from
// migrations/0001_create_users_table.sql, 0002_create_sessions_table.sql,
// and 0004_reconcile_better_auth_schema.sql. Only the columns Better Auth's
// core (non-plugin) traits require are modelled; `users.password_hash` is
// deliberately left unmapped (unused -- credentials live in `accounts`).
// ---------------------------------------------------------------------------

pub mod user {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub email: String,
        pub email_verified: bool,
        pub name: Option<String>,
        pub image: Option<String>,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod session {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, DeriveEntityModel)]
    #[sea_orm(table_name = "sessions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub token: String,
        pub expires_at: DateTimeUtc,
        pub ip_address: Option<String>,
        pub user_agent: Option<String>,
        pub active: bool,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod account {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, DeriveEntityModel)]
    #[sea_orm(table_name = "accounts")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub account_id: String,
        pub provider_id: String,
        pub user_id: Uuid,
        pub access_token: Option<String>,
        pub refresh_token: Option<String>,
        pub id_token: Option<String>,
        pub access_token_expires_at: Option<DateTimeUtc>,
        pub refresh_token_expires_at: Option<DateTimeUtc>,
        pub scope: Option<String>,
        // Holds the Argon2 password hash for the "credential" provider.
        // Never serialized back out to a response body -- callers of this
        // module only ever see `better_auth::prelude`'s `UserView` (no
        // account fields at all) or this module's own `PublicUser`.
        pub password: Option<String>,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod verification {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, DeriveEntityModel)]
    #[sea_orm(table_name = "verifications")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub identifier: String,
        pub value: String,
        pub expires_at: DateTimeUtc,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

// ---------------------------------------------------------------------------
// Trait impls -- wire the entities above into Better Auth's core traits.
// Optional (plugin-gated) fields on `AuthUser` / `AuthSession` are not
// backed by columns: this app only enables the email/password plugin, so
// they're implemented as constants (see issue #17's "out of scope" list --
// OAuth/2FA/organization/admin features are explicitly excluded).
// ---------------------------------------------------------------------------

fn empty_metadata() -> &'static Value {
    static EMPTY: LazyLock<Value> = LazyLock::new(|| json!({}));
    &EMPTY
}

impl AuthUser for user::Model {
    fn id(&self) -> Cow<'_, str> {
        Cow::Owned(self.id.to_string())
    }
    fn email(&self) -> Option<&str> {
        Some(self.email.as_str())
    }
    fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }
    fn email_verified(&self) -> bool {
        self.email_verified
    }
    fn image(&self) -> Option<&str> {
        self.image.as_deref()
    }
    fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }
    fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }
    fn username(&self) -> Option<&str> {
        None
    }
    fn display_username(&self) -> Option<&str> {
        None
    }
    fn two_factor_enabled(&self) -> bool {
        false
    }
    fn role(&self) -> Option<&str> {
        None
    }
    fn banned(&self) -> bool {
        false
    }
    fn ban_reason(&self) -> Option<&str> {
        None
    }
    fn ban_expires(&self) -> Option<DateTime<Utc>> {
        None
    }
    fn metadata(&self) -> &Value {
        empty_metadata()
    }
}

impl SeaOrmUserModel for user::Model {
    type Id = Uuid;
    type Entity = user::Entity;
    type ActiveModel = user::ActiveModel;
    type Column = user::Column;

    fn id_column() -> Self::Column {
        user::Column::Id
    }
    fn email_column() -> Self::Column {
        user::Column::Email
    }
    fn name_column() -> Self::Column {
        user::Column::Name
    }
    fn created_at_column() -> Self::Column {
        user::Column::CreatedAt
    }
    fn parse_id(id: &str) -> AuthResult<Self::Id> {
        Uuid::parse_str(id).map_err(|_| AuthError::bad_request("Invalid user id"))
    }

    fn new_active(
        id: Option<Self::Id>,
        create_user: CreateUser,
        now: DateTime<Utc>,
    ) -> Self::ActiveModel {
        user::ActiveModel {
            id: Set(id.unwrap_or_else(Uuid::new_v4)),
            email: Set(create_user.email.unwrap_or_default()),
            name: Set(create_user.name),
            image: Set(create_user.image),
            email_verified: Set(create_user.email_verified.unwrap_or(false)),
            created_at: Set(now),
            updated_at: Set(now),
        }
    }

    fn apply_update(active: &mut Self::ActiveModel, update: UpdateUser, now: DateTime<Utc>) {
        if let Some(email) = update.email {
            active.email = Set(email);
        }
        if let Some(name) = update.name {
            active.name = Set(Some(name));
        }
        if let Some(image) = update.image {
            active.image = Set(Some(image));
        }
        if let Some(email_verified) = update.email_verified {
            active.email_verified = Set(email_verified);
        }
        active.updated_at = Set(now);
    }
}

impl AuthSession for session::Model {
    fn id(&self) -> Cow<'_, str> {
        Cow::Owned(self.id.to_string())
    }
    fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
    fn token(&self) -> &str {
        &self.token
    }
    fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }
    fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }
    fn ip_address(&self) -> Option<&str> {
        self.ip_address.as_deref()
    }
    fn user_agent(&self) -> Option<&str> {
        self.user_agent.as_deref()
    }
    fn user_id(&self) -> Cow<'_, str> {
        Cow::Owned(self.user_id.to_string())
    }
    fn impersonated_by(&self) -> Option<&str> {
        None
    }
    fn active_organization_id(&self) -> Option<&str> {
        None
    }
    fn active(&self) -> bool {
        self.active
    }
}

impl SeaOrmSessionModel for session::Model {
    type Id = Uuid;
    type UserId = Uuid;
    type Entity = session::Entity;
    type ActiveModel = session::ActiveModel;
    type Column = session::Column;

    fn id_column() -> Self::Column {
        session::Column::Id
    }
    fn token_column() -> Self::Column {
        session::Column::Token
    }
    fn user_id_column() -> Self::Column {
        session::Column::UserId
    }
    fn active_column() -> Self::Column {
        session::Column::Active
    }
    fn expires_at_column() -> Self::Column {
        session::Column::ExpiresAt
    }
    fn created_at_column() -> Self::Column {
        session::Column::CreatedAt
    }
    fn parse_id(id: &str) -> AuthResult<Self::Id> {
        Uuid::parse_str(id).map_err(|_| AuthError::bad_request("Invalid session id"))
    }
    fn parse_user_id(user_id: &str) -> AuthResult<Self::UserId> {
        Uuid::parse_str(user_id).map_err(|_| AuthError::bad_request("Invalid session user id"))
    }

    fn new_active(
        id: Option<Self::Id>,
        token: String,
        create_session: CreateSession,
        now: DateTime<Utc>,
    ) -> Self::ActiveModel {
        let user_id = Uuid::parse_str(&create_session.user_id)
            .expect("session user ids come from validated auth user identifiers");
        session::ActiveModel {
            id: Set(id.unwrap_or_else(Uuid::new_v4)),
            user_id: Set(user_id),
            token: Set(token),
            expires_at: Set(create_session.expires_at),
            ip_address: Set(create_session.ip_address),
            user_agent: Set(create_session.user_agent),
            active: Set(true),
            created_at: Set(now),
            updated_at: Set(now),
        }
    }

    fn set_expires_at(active: &mut Self::ActiveModel, expires_at: DateTime<Utc>) {
        active.expires_at = Set(expires_at);
    }
    fn set_updated_at(active: &mut Self::ActiveModel, updated_at: DateTime<Utc>) {
        active.updated_at = Set(updated_at);
    }
    fn set_active_organization_id(
        _active: &mut Self::ActiveModel,
        _organization_id: Option<String>,
    ) {
        // Organization plugin not enabled -- no-op (see issue #17 out of scope).
    }
}

impl AuthAccount for account::Model {
    fn id(&self) -> Cow<'_, str> {
        Cow::Owned(self.id.to_string())
    }
    fn account_id(&self) -> &str {
        &self.account_id
    }
    fn provider_id(&self) -> &str {
        &self.provider_id
    }
    fn user_id(&self) -> Cow<'_, str> {
        Cow::Owned(self.user_id.to_string())
    }
    fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref()
    }
    fn refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }
    fn id_token(&self) -> Option<&str> {
        self.id_token.as_deref()
    }
    fn access_token_expires_at(&self) -> Option<DateTime<Utc>> {
        self.access_token_expires_at
    }
    fn refresh_token_expires_at(&self) -> Option<DateTime<Utc>> {
        self.refresh_token_expires_at
    }
    fn scope(&self) -> Option<&str> {
        self.scope.as_deref()
    }
    fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }
    fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }
    fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }
}

impl SeaOrmAccountModel for account::Model {
    type Id = Uuid;
    type UserId = Uuid;
    type Entity = account::Entity;
    type ActiveModel = account::ActiveModel;
    type Column = account::Column;

    fn id_column() -> Self::Column {
        account::Column::Id
    }
    fn provider_id_column() -> Self::Column {
        account::Column::ProviderId
    }
    fn account_id_column() -> Self::Column {
        account::Column::AccountId
    }
    fn user_id_column() -> Self::Column {
        account::Column::UserId
    }
    fn created_at_column() -> Self::Column {
        account::Column::CreatedAt
    }
    fn parse_id(id: &str) -> AuthResult<Self::Id> {
        Uuid::parse_str(id).map_err(|_| AuthError::bad_request("Invalid account id"))
    }
    fn parse_user_id(user_id: &str) -> AuthResult<Self::UserId> {
        Uuid::parse_str(user_id).map_err(|_| AuthError::bad_request("Invalid account user id"))
    }

    fn new_active(
        id: Option<Self::Id>,
        create_account: CreateAccount,
        now: DateTime<Utc>,
    ) -> Self::ActiveModel {
        let user_id = Uuid::parse_str(&create_account.user_id)
            .expect("account user ids come from validated auth user identifiers");
        account::ActiveModel {
            id: Set(id.unwrap_or_else(Uuid::new_v4)),
            account_id: Set(create_account.account_id),
            provider_id: Set(create_account.provider_id),
            user_id: Set(user_id),
            access_token: Set(create_account.access_token),
            refresh_token: Set(create_account.refresh_token),
            id_token: Set(create_account.id_token),
            access_token_expires_at: Set(create_account.access_token_expires_at),
            refresh_token_expires_at: Set(create_account.refresh_token_expires_at),
            scope: Set(create_account.scope),
            password: Set(create_account.password),
            created_at: Set(now),
            updated_at: Set(now),
        }
    }

    fn apply_update(active: &mut Self::ActiveModel, update: UpdateAccount, now: DateTime<Utc>) {
        if let Some(access_token) = update.access_token {
            active.access_token = Set(Some(access_token));
        }
        if let Some(refresh_token) = update.refresh_token {
            active.refresh_token = Set(Some(refresh_token));
        }
        if let Some(id_token) = update.id_token {
            active.id_token = Set(Some(id_token));
        }
        if let Some(v) = update.access_token_expires_at {
            active.access_token_expires_at = Set(Some(v));
        }
        if let Some(v) = update.refresh_token_expires_at {
            active.refresh_token_expires_at = Set(Some(v));
        }
        if let Some(scope) = update.scope {
            active.scope = Set(Some(scope));
        }
        if let Some(password) = update.password {
            active.password = Set(Some(password));
        }
        active.updated_at = Set(now);
    }
}

impl AuthVerification for verification::Model {
    fn id(&self) -> Cow<'_, str> {
        Cow::Owned(self.id.to_string())
    }
    fn identifier(&self) -> &str {
        &self.identifier
    }
    fn value(&self) -> &str {
        &self.value
    }
    fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
    fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }
    fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }
}

impl SeaOrmVerificationModel for verification::Model {
    type Id = Uuid;
    type Entity = verification::Entity;
    type ActiveModel = verification::ActiveModel;
    type Column = verification::Column;

    fn id_column() -> Self::Column {
        verification::Column::Id
    }
    fn identifier_column() -> Self::Column {
        verification::Column::Identifier
    }
    fn value_column() -> Self::Column {
        verification::Column::Value
    }
    fn expires_at_column() -> Self::Column {
        verification::Column::ExpiresAt
    }
    fn created_at_column() -> Self::Column {
        verification::Column::CreatedAt
    }
    fn parse_id(id: &str) -> AuthResult<Self::Id> {
        Uuid::parse_str(id).map_err(|_| AuthError::bad_request("Invalid verification id"))
    }

    fn new_active(
        id: Option<Self::Id>,
        verification: CreateVerification,
        now: DateTime<Utc>,
    ) -> Self::ActiveModel {
        verification::ActiveModel {
            id: Set(id.unwrap_or_else(Uuid::new_v4)),
            identifier: Set(verification.identifier),
            value: Set(verification.value),
            expires_at: Set(verification.expires_at),
            created_at: Set(now),
            updated_at: Set(now),
        }
    }
}

pub struct AppAuthSchema;

impl AuthSchema for AppAuthSchema {
    type User = user::Model;
    type Session = session::Model;
    type Account = account::Model;
    type Verification = verification::Model;
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

/// Failures constructing the `BetterAuth` instance at startup.
#[derive(Debug)]
pub enum AuthBuildError {
    Connect(sea_orm::DbErr),
    Build(AuthError),
}

impl std::fmt::Display for AuthBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthBuildError::Connect(err) => write!(f, "failed to connect to Postgres: {err}"),
            AuthBuildError::Build(err) => write!(f, "failed to build BetterAuth: {err}"),
        }
    }
}

impl std::error::Error for AuthBuildError {}

/// Connect to Postgres via SeaORM and build a `BetterAuth` instance backed
/// by this module's entities. `secret` must be at least 32 bytes (enforced
/// by `better-auth` itself).
pub async fn build_auth(
    database_url: &str,
    secret: &str,
) -> Result<Arc<BetterAuth<AppAuthSchema>>, AuthBuildError> {
    let database: DatabaseConnection = Database::connect(database_url)
        .await
        .map_err(AuthBuildError::Connect)?;

    let config = AuthConfig::new(secret)
        .base_url("http://localhost:3000")
        .password_min_length(8);
    let store = SeaOrmStore::<AppAuthSchema>::new(config.clone(), database);

    let auth = BetterAuth::<AppAuthSchema>::new(config)
        .store(store)
        .plugin(EmailPasswordPlugin::new().enable_signup(true))
        .build()
        .await
        .map_err(AuthBuildError::Build)?;

    Ok(Arc::new(auth))
}

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<BetterAuth<AppAuthSchema>>,
}

/// The axum router for `/signup`, `/login`, and (by composition with other
/// routers in this crate) anything gated behind [`AuthenticatedUser`].
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/signup", post(signup))
        .route("/login", post(login))
        .with_state(state)
}

async fn dispatch(
    auth: &BetterAuth<AppAuthSchema>,
    path: &str,
    body: &Value,
) -> better_auth::prelude::AuthResponse {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    let req = AuthRequest::from_parts(
        HttpMethod::Post,
        path.to_string(),
        headers,
        Some(body.to_string().into_bytes()),
        HashMap::new(),
    );
    match auth.handle_request(req).await {
        Ok(resp) => resp,
        Err(err) => err.to_auth_response(),
    }
}

fn json_body(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

fn placeholder_name(email: &str) -> String {
    match email.split('@').next() {
        Some(local) if !local.is_empty() => local.to_string(),
        _ => "user".to_string(),
    }
}

#[derive(Debug, Deserialize, Default)]
struct SignupPayload {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct LoginPayload {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

async fn signup(State(state): State<AppState>, Json(payload): Json<SignupPayload>) -> Response {
    let email = payload.email.unwrap_or_default();
    let password = payload.password.unwrap_or_default();
    let name = placeholder_name(&email);

    let body = json!({
        "email": email,
        "password": password,
        "name": name,
    });
    let resp = dispatch(&state.auth, "/sign-up/email", &body).await;

    match resp.status {
        200 => {
            let parsed = json_body(&resp.body);
            let token = parsed
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let user = parsed.get("user").cloned().unwrap_or(json!({}));
            (
                StatusCode::CREATED,
                Json(json!({ "token": token, "user": user })),
            )
                .into_response()
        }
        // The TS-compatible better-auth wire protocol returns 422 for a
        // duplicate email; this app's contract (issue #17) wants 409.
        422 => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "email already registered" })),
        )
            .into_response(),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid input" })),
        )
            .into_response(),
    }
}

async fn login(State(state): State<AppState>, Json(payload): Json<LoginPayload>) -> Response {
    let email = payload.email.unwrap_or_default();
    let password = payload.password.unwrap_or_default();

    let body = json!({ "email": email, "password": password });
    let resp = dispatch(&state.auth, "/sign-in/email", &body).await;

    match resp.status {
        200 => {
            let parsed = json_body(&resp.body);
            let token = parsed
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let user = parsed.get("user").cloned().unwrap_or(json!({}));
            (
                StatusCode::OK,
                Json(json!({ "token": token, "user": user })),
            )
                .into_response()
        }
        // Wrong password and unknown email both surface as
        // `AuthError::InvalidCredentials` from better-auth (401) -- this
        // handler always emits the same literal body for either case so
        // this app's contract can't leak which one it was, independent of
        // whatever message text the crate happens to use internally.
        401 => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid credentials" })),
        )
            .into_response(),
        status => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({ "error": "invalid input" })),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// Bearer-token extractor for protected routes.
// ---------------------------------------------------------------------------

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn bearer_token(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

/// Authenticated user + session, extracted from a valid `Authorization:
/// Bearer <token>` header. Rejects missing, invalid (unknown/malformed),
/// and expired tokens uniformly with `401 {"error":"unauthorized"}`.
///
/// This does not reuse `better_auth::integrations::axum::CurrentSession`
/// directly: that extractor calls the store's raw `get_session` (which does
/// not check expiry) rather than `BetterAuth::session_manager()` (which
/// does), and its rejection body/status don't match this app's `401
/// {"error":"unauthorized"}` contract. It's built from the same public
/// `BetterAuth` API (`session_manager()`, `store()`) that the crate's own
/// extractor uses internally.
pub struct AuthenticatedUser {
    pub user: user::Model,
    pub session: session::Model,
}

impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or_else(unauthorized)?;

        let session = state
            .auth
            .session_manager()
            .get_session(&token)
            .await
            .map_err(|_| unauthorized())?
            .ok_or_else(unauthorized)?;

        let user = state
            .auth
            .store()
            .get_user_by_id(&session.user_id())
            .await
            .map_err(|_| unauthorized())?
            .ok_or_else(unauthorized)?;

        Ok(AuthenticatedUser { user, session })
    }
}
