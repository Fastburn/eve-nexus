// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! ESI OAuth2 PKCE flow, token refresh, and token storage.
//!
//! Flow: open browser → local callback server → exchange code → store tokens.
//! Tokens are stored in the OS keychain via the `keyring` crate. On platforms
//! where the keychain is unavailable (e.g. WSL2 without a secret-service daemon)
//! we fall back to the local SQLite database, which is protected by OS file
//! permissions on the app data directory.

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::db::local::LocalDb;
use crate::types::CharacterId;

// ─── Constants ────────────────────────────────────────────────────────────────

/// EVE ESI application client ID.
/// Registered at https://developers.eveonline.com/ — callback URL is
/// http://localhost:21468 (no path).
const CLIENT_ID: &str = "93fabb6051cb43ffa0866bddbd96cb96";

const AUTH_URL: &str = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_URL: &str = "https://login.eveonline.com/v2/oauth/token";

const SCOPES: &str = concat!(
    "esi-assets.read_assets.v1 ",
    "esi-assets.read_corporation_assets.v1 ",
    "esi-characters.read_blueprints.v1 ",
    "esi-corporations.read_blueprints.v1 ",
    "esi-industry.read_character_jobs.v1 ",
    "esi-industry.read_corporation_jobs.v1 ",
    "esi-markets.read_character_orders.v1 ",
    "esi-markets.structure_markets.v1 ",
    "esi-skills.read_skills.v1 ",
    "esi-universe.read_structures.v1 ",
    "esi-wallet.read_character_wallet.v1",
);

const KEYRING_SERVICE: &str = "eve-nexus";
/// Timeout waiting for the browser callback.
const CALLBACK_TIMEOUT_SECS: u64 = 60;

// ─── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Keychain error: {0}")]
    Keychain(String),
    #[error("OAuth state mismatch — possible CSRF")]
    StateMismatch,
    #[error("No authorization code in callback")]
    NoAuthCode,
    #[error("Browser callback timed out")]
    Timeout,
    #[error("Could not parse token: {0}")]
    ParseToken(String),
    #[error("No refresh token stored for character {0}")]
    NoRefreshToken(CharacterId),
    #[error("EVE SSO token endpoint returned {status}: {body}")]
    TokenEndpoint { status: u16, body: String },
    #[error("{0}'s session has expired, please sign in again")]
    NeedsReauth(String),
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        AuthError::Keychain(e.to_string())
    }
}

// ─── Token response from CCP SSO ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

// ─── AuthManager ─────────────────────────────────────────────────────────────

/// Manages the OAuth2 PKCE flow and token lifecycle.
///
/// Tries the OS keychain first; falls back to `LocalDb` when the keychain is
/// unavailable (e.g. WSL2 without a secret-service daemon).
pub struct AuthManager {
    http: reqwest::Client,
    local: Arc<LocalDb>,
    /// Ensures only one auth flow runs at a time (port 21468 can only be held by one listener).
    auth_lock: tokio::sync::Mutex<()>,
    /// Per-character locks serializing token refresh. EVE SSO rotates the
    /// refresh token on every use, so concurrent refreshes for the same
    /// character (e.g. several ESI calls firing at once via `refresh_all`)
    /// would race: only the first succeeds and the rest get a 400 from a
    /// refresh token already invalidated by that first call.
    refresh_locks: std::sync::Mutex<std::collections::HashMap<CharacterId, Arc<tokio::sync::Mutex<()>>>>,
}

impl AuthManager {
    pub fn new(local: Arc<LocalDb>) -> Self {
        Self {
            local,
            auth_lock: tokio::sync::Mutex::new(()),
            refresh_locks: std::sync::Mutex::new(std::collections::HashMap::new()),
            http: reqwest::Client::builder()
                .user_agent(concat!(
                    "EveNexus/",
                    env!("CARGO_PKG_VERSION"),
                    " (contact via GitHub)"
                ))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("could not build auth HTTP client"),
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /// Run the full OAuth2 PKCE flow.
    /// Opens the user's browser, waits for the callback, exchanges the code
    /// for tokens, and stores them in the OS keychain.
    ///
    /// Returns `(character_id, character_name)` on success.
    pub async fn start_auth_flow(&self, app: &tauri::AppHandle) -> Result<(CharacterId, String), AuthError> {
        // Only one auth flow at a time — port 21468 can't be shared.
        let _lock = self.auth_lock.try_lock().map_err(|_| {
            AuthError::Io(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "An authentication window is already open. Complete it or wait 60 seconds for it to expire.",
            ))
        })?;

        // ── PKCE ─────────────────────────────────────────────────────────────
        let code_verifier = pkce_verifier();
        let code_challenge = pkce_challenge(&code_verifier);
        let state = random_state();

        // ── Local callback server ─────────────────────────────────────────────
        // Fixed port so the redirect URI is predictable and can be registered
        // in the EVE developer portal as http://localhost:21468
        const CALLBACK_PORT: u16 = 21468;
        // In debug builds (WSL2 dev), bind to all interfaces so the Windows
        // browser can reach the WSL2 listener. In release builds the browser
        // is always on the same machine, so loopback is sufficient and safer.
        #[cfg(debug_assertions)]
        let bind_addr = "0.0.0.0";
        #[cfg(not(debug_assertions))]
        let bind_addr = "127.0.0.1";
        let listener = TcpListener::bind((bind_addr, CALLBACK_PORT)).await?;
        let redirect_uri = format!("http://localhost:{CALLBACK_PORT}");

        // ── Open browser ──────────────────────────────────────────────────────
        let auth_url = build_auth_url(&redirect_uri, &code_challenge, &state);
        open_in_browser(app, &auth_url)?;

        // ── Wait for callback ─────────────────────────────────────────────────
        let code = tokio::time::timeout(
            Duration::from_secs(CALLBACK_TIMEOUT_SECS),
            wait_for_callback(listener, &state),
        )
        .await
        .map_err(|_| AuthError::Timeout)??;

        // ── Exchange code for tokens ──────────────────────────────────────────
        let tokens = self
            .exchange_code(&code, &code_verifier, &redirect_uri)
            .await?;

        let expires_at = Utc::now() + chrono::Duration::seconds(tokens.expires_in as i64 - 30);

        // ── Extract character info from JWT ───────────────────────────────────
        let character_id = extract_character_id(&tokens.access_token)
            .ok_or_else(|| AuthError::ParseToken("missing character ID in JWT".into()))?;
        let character_name = extract_character_name(&tokens.access_token)
            .unwrap_or_else(|| format!("Character {character_id}"));

        // ── Store tokens ──────────────────────────────────────────────────────
        self.store_tokens(character_id, &tokens.access_token, &tokens.refresh_token, expires_at)?;

        Ok((character_id, character_name))
    }

    /// Return a valid access token for `character_id`, refreshing if needed.
    pub async fn get_access_token(&self, character_id: CharacterId) -> Result<String, AuthError> {
        let local = self.local.clone();
        let cid = character_id;
        let (access, expiry) = tokio::task::spawn_blocking(move || {
            let access = token_load(&local, &keyring_key_access(cid)).ok();
            let expiry = token_load(&local, &keyring_key_expiry(cid))
                .ok()
                .flatten()
                .and_then(|s| s.parse::<DateTime<Utc>>().ok());
            (access.flatten(), expiry)
        })
        .await
        .unwrap_or((None, None));

        if let (Some(token), Some(exp)) = (access, expiry) {
            if exp > Utc::now() {
                return Ok(token);
            }
        }

        // Serialize refreshes per character. See `refresh_locks` doc comment.
        let lock = {
            let mut locks = self.refresh_locks.lock().unwrap_or_else(|e| e.into_inner());
            locks.entry(cid).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
        };
        let _guard = lock.lock().await;

        // Re-check: another task may have refreshed while we waited for the lock.
        let local3 = self.local.clone();
        let (access2, expiry2) = tokio::task::spawn_blocking(move || {
            let access = token_load(&local3, &keyring_key_access(cid)).ok();
            let expiry = token_load(&local3, &keyring_key_expiry(cid))
                .ok()
                .flatten()
                .and_then(|s| s.parse::<DateTime<Utc>>().ok());
            (access.flatten(), expiry)
        })
        .await
        .unwrap_or((None, None));

        if let (Some(token), Some(exp)) = (access2, expiry2) {
            if exp > Utc::now() {
                return Ok(token);
            }
        }

        let local2 = self.local.clone();
        let refresh = tokio::task::spawn_blocking(move || {
            token_load(&local2, &keyring_key_refresh(cid))
                .ok()
                .flatten()
                .ok_or(AuthError::NoRefreshToken(cid))
        })
        .await
        .map_err(|_| AuthError::NoRefreshToken(cid))??;

        let tokens = match self.refresh_tokens(&refresh).await {
            Ok(t) => t,
            Err(AuthError::TokenEndpoint { status: 400, body }) if body.contains("invalid_grant") => {
                // Refresh token is permanently dead (revoked, or orphaned by a
                // past rotation race). Clear it so future calls fail fast
                // with a clear re-auth prompt instead of retrying forever.
                let _ = self.remove_tokens(character_id);
                let who = self
                    .local
                    .get_characters()
                    .ok()
                    .and_then(|chars| chars.into_iter().find(|(id, _)| *id == character_id).map(|(_, name)| name))
                    .unwrap_or_else(|| format!("Character {character_id}"));
                return Err(AuthError::NeedsReauth(who));
            }
            Err(e) => return Err(e),
        };
        let expires_at =
            Utc::now() + chrono::Duration::seconds(tokens.expires_in as i64 - 30);

        self.store_tokens(
            character_id,
            &tokens.access_token,
            &tokens.refresh_token,
            expires_at,
        )?;

        Ok(tokens.access_token)
    }

    /// Returns `true` if a refresh token is stored for this character.
    pub fn has_tokens(&self, character_id: CharacterId) -> bool {
        token_load(&self.local, &keyring_key_refresh(character_id))
            .ok()
            .flatten()
            .is_some()
    }

    /// Delete all stored tokens for a character.
    pub fn remove_tokens(&self, character_id: CharacterId) -> Result<(), AuthError> {
        token_delete(&self.local, &keyring_key_access(character_id));
        token_delete(&self.local, &keyring_key_refresh(character_id));
        token_delete(&self.local, &keyring_key_expiry(character_id));
        Ok(())
    }

    fn store_tokens(
        &self,
        character_id: CharacterId,
        access_token: &str,
        refresh_token: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), AuthError> {
        token_store(&self.local, &keyring_key_access(character_id), access_token)?;
        token_store(&self.local, &keyring_key_refresh(character_id), refresh_token)?;
        token_store(&self.local, &keyring_key_expiry(character_id), &expires_at.to_rfc3339())?;
        Ok(())
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    async fn exchange_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, AuthError> {
        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("client_id", CLIENT_ID),
                ("code_verifier", code_verifier),
                ("redirect_uri", redirect_uri),
            ])
            .send()
            .await?;
        Self::parse_token_response(response, "exchange_code").await
    }

    async fn refresh_tokens(&self, refresh_token: &str) -> Result<TokenResponse, AuthError> {
        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .await?;
        Self::parse_token_response(response, "refresh_tokens").await
    }

    async fn parse_token_response(
        response: reqwest::Response,
        context: &str,
    ) -> Result<TokenResponse, AuthError> {
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            eprintln!("[auth] {context}: SSO token endpoint returned {status}: {body}");
            return Err(AuthError::TokenEndpoint { status: status.as_u16(), body });
        }
        let body = response.text().await.map_err(AuthError::Http)?;
        serde_json::from_str::<TokenResponse>(&body).map_err(|e| {
            eprintln!("[auth] {context}: failed to parse token response: {e}\nBody: {body}");
            AuthError::ParseToken(e.to_string())
        })
    }
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

fn pkce_verifier() -> String {
    let bytes: Vec<u8> = rand::rngs::OsRng
        .sample_iter(rand::distributions::Standard)
        .take(32)
        .collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

fn random_state() -> String {
    let bytes: Vec<u8> = rand::rngs::OsRng
        .sample_iter(rand::distributions::Standard)
        .take(16)
        .collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

// ─── URL building ─────────────────────────────────────────────────────────────

fn build_auth_url(redirect_uri: &str, code_challenge: &str, state: &str) -> String {
    // EVE SSO compares redirect_uri by raw string — send it unencoded so the
    // value the server sees matches what was registered in the portal exactly.
    // Scopes still need encoding because they contain spaces.
    // prompt=login forces EVE SSO to show a fresh login screen every time,
    // so adding a second account doesn't silently re-auth the first character.
    format!(
        "{AUTH_URL}?response_type=code\
         &client_id={CLIENT_ID}\
         &redirect_uri={redirect_uri}\
         &scope={}\
         &code_challenge={code_challenge}\
         &code_challenge_method=S256\
         &state={state}\
         &prompt=login",
        urlencode(SCOPES),
    )
}

/// Percent-encode a string for use as a URL query parameter value.
/// Encodes everything except unreserved characters (RFC 3986).
fn urlencode(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
        | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

// ─── Local callback server ────────────────────────────────────────────────────

async fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, AuthError> {
    let (mut stream, _) = listener.accept().await?;

    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse "GET /?code=...&state=... HTTP/1.1"
    let path = request
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "code" => code = Some(v.to_string()),
                "state" => state = Some(v.to_string()),
                _ => {}
            }
        }
    }

    // Respond so the browser doesn't hang.
    // Both code and state must be present and valid for a true success.
    let is_success = code.is_some() && state.as_deref() == Some(expected_state);
    let (title, message) = if is_success {
        ("Authentication Successful", "You can close this tab and return to Eve Nexus.")
    } else {
        ("Authentication Failed", "Something went wrong. Please close this tab and try again.")
    };
    let accent = if is_success { "#4d9de0" } else { "#e05252" };
    let body = format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: #e2e8f0;
    }}
    .card {{
      background: #1e2a3a;
      border: 1px solid #2d3f55;
      border-radius: 12px;
      padding: 40px 48px;
      max-width: 420px;
      width: 90%;
      text-align: center;
    }}
    .icon {{
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: {accent}22;
      border: 2px solid {accent};
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 22px;
    }}
    h1 {{
      margin: 0 0 12px;
      font-size: 20px;
      font-weight: 700;
      color: #f1f5f9;
      letter-spacing: 0.02em;
    }}
    p {{
      margin: 0;
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.6;
    }}
    .brand {{
      margin-top: 32px;
      font-size: 11px;
      color: #4d9de0;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 600;
    }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">{}</div>
    <h1>{title}</h1>
    <p>{message}</p>
    <div class="brand">Eve Nexus</div>
  </div>
</body>
</html>"#, if is_success { "✓" } else { "✕" });
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;

    if state.as_deref() != Some(expected_state) {
        return Err(AuthError::StateMismatch);
    }

    code.ok_or(AuthError::NoAuthCode)
}

// ─── JWT parsing (no signature verification — we trust CCP's HTTPS) ───────────

fn extract_character_id(jwt: &str) -> Option<CharacterId> {
    let payload = decode_jwt_payload(jwt)?;
    // sub format: "CHARACTER:EVE:12345678"
    let sub = payload.get("sub")?.as_str()?;
    sub.split(':').last()?.parse().ok()
}

fn extract_character_name(jwt: &str) -> Option<String> {
    let payload = decode_jwt_payload(jwt)?;
    payload.get("name")?.as_str().map(str::to_string)
}

fn decode_jwt_payload(jwt: &str) -> Option<serde_json::Value> {
    let encoded = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ─── Keychain helpers ─────────────────────────────────────────────────────────

fn keyring_key_access(character_id: CharacterId) -> String {
    format!("char:{character_id}:access_token")
}

fn keyring_key_refresh(character_id: CharacterId) -> String {
    format!("char:{character_id}:refresh_token")
}

fn keyring_key_expiry(character_id: CharacterId) -> String {
    format!("char:{character_id}:expires_at")
}

// ─── Token storage: keyring with DB fallback ─────────────────────────────────
//
// On platforms where the OS keychain is unavailable, we fall back to the
// local SQLite database. The DB file sits in the app data directory which is
// user-owned (chmod 700 on Linux), giving equivalent protection to a desktop
// deployment.
//
// The DB is plaintext, so we only want it holding a copy when the keychain
// genuinely can't be trusted — not on every platform as a matter of course.
// A keychain write can silently "succeed" while a later read in a fresh
// session fails, so we verify the write round-trips before treating the
// keychain as authoritative.

fn token_store(local: &LocalDb, key: &str, value: &str) -> Result<(), AuthError> {
    let keychain_verified = keyring::Entry::new(KEYRING_SERVICE, key)
        .and_then(|entry| entry.set_password(value).and_then(|_| entry.get_password()))
        .map(|roundtrip| roundtrip == value)
        .unwrap_or(false);

    if keychain_verified {
        // Keychain has a verified copy — don't also leave plaintext in the DB.
        let _ = local.delete_token(key);
        return Ok(());
    }

    eprintln!("[auth] keychain unavailable/unverified for {key}; falling back to local DB");
    local.set_token(key, value)
        .map_err(|e| AuthError::Keychain(e.to_string()))
}

fn token_load(local: &LocalDb, key: &str) -> Result<Option<String>, AuthError> {
    // Try OS keychain first.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key) {
        match entry.get_password() {
            Ok(v) => return Ok(Some(v)),
            Err(keyring::Error::NoEntry) => {} // not in keychain — check DB
            Err(_) => {}                        // keychain unavailable — check DB
        }
    }
    // Fall back to local DB.
    local.get_token(key)
        .map_err(|e| AuthError::Keychain(e.to_string()))
}

fn token_delete(local: &LocalDb, key: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key) {
        let _ = entry.delete_credential();
    }
    let _ = local.delete_token(key);
}

// ─── Cross-platform browser opener ───────────────────────────────────────────

/// Open a URL in the system browser via tauri-plugin-opener.
/// This handles URL encoding and OS-specific quirks (e.g. & in cmd.exe on
/// Windows) correctly across all platforms.
fn open_in_browser(app: &tauri::AppHandle, url: &str) -> std::io::Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

// ─── Managed state ────────────────────────────────────────────────────────────

pub struct AuthState(pub std::sync::Arc<AuthManager>);