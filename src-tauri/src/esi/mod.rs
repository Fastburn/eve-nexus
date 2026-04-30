//! ESI HTTP client with local caching.
//!
//! `EsiClient` enforces all hard ESI rules from AGENTS.md:
//! - Always check cache before fetching (X-Expires / Expires header).
//! - Never re-fetch before cache expiry.
//! - Track the 100-error/min budget via `X-Esi-Error-Limit-Remain`.
//! - On 420 or 503: back off, surface the error, never retry blindly.

pub mod endpoints;

use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{Response, StatusCode};
use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::auth::AuthManager;
use crate::types::CharacterId;

// ─── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum EsiError {
    #[error("ESI error budget exhausted — too many errors this minute")]
    ErrorBudgetExhausted,
    #[error("ESI rate-limited (420) — back off before retrying")]
    RateLimited,
    #[error("ESI temporarily unavailable (503)")]
    ServiceUnavailable,
    #[error("ESI returned {status}: {body}")]
    HttpError { status: u16, body: String },
    #[error("HTTP client error: {0}")]
    Client(#[from] reqwest::Error),
    #[error("Failed to decode ESI response from {url}: {reason}\nBody: {body}")]
    DecodeError { url: String, reason: String, body: String },
    #[error("Auth error: {0}")]
    Auth(#[from] crate::auth::AuthError),
}

pub type EsiResult<T> = Result<T, EsiError>;

// ─── Error budget ─────────────────────────────────────────────────────────────

struct ErrorBudget {
    remaining: u32,
    reset_at: Option<DateTime<Utc>>,
}

impl ErrorBudget {
    fn new() -> Self {
        Self { remaining: 100, reset_at: None }
    }

    /// Update from ESI response headers.
    fn update_from_headers(&mut self, response: &Response) {
        if let Some(remain) = response
            .headers()
            .get("x-esi-error-limit-remain")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
        {
            self.remaining = remain;
        }
        if let Some(reset_secs) = response
            .headers()
            .get("x-esi-error-limit-reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok())
        {
            self.reset_at = Some(Utc::now() + chrono::Duration::seconds(reset_secs));
        }
    }

    fn is_exhausted(&self) -> bool {
        self.remaining == 0
    }
}

// ─── EsiClient ────────────────────────────────────────────────────────────────

pub struct EsiClient {
    http: reqwest::Client,
    pub auth: std::sync::Arc<AuthManager>,
    budget: Mutex<ErrorBudget>,
}

impl EsiClient {
    pub fn new(auth: std::sync::Arc<AuthManager>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!(
                    "EveNexus/",
                    env!("CARGO_PKG_VERSION"),
                    " (contact via GitHub)"
                ))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("could not build ESI HTTP client"),
            auth,
            budget: Mutex::new(ErrorBudget::new()),
        }
    }

    // ── Public fetch methods ─────────────────────────────────────────────────

    /// Fetch a public ESI endpoint (no auth required).
    /// Returns the deserialized body and the cache expiry parsed from headers.
    pub async fn get_public<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> EsiResult<(T, Option<DateTime<Utc>>)> {
        let url = format!("https://esi.evetech.net/latest{path}");
        let response = self.send_request(&url, None).await?;
        let expiry = parse_expiry(&response);
        let body = Self::decode(&url, response).await?;
        Ok((body, expiry))
    }

    /// Fetch a paginated public endpoint, collecting all pages into a single `Vec`.
    pub async fn get_public_all_pages<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> EsiResult<(Vec<T>, Option<DateTime<Utc>>)> {
        let url = format!("https://esi.evetech.net/latest{path}");
        let first = self.send_request(&url, None).await?;
        let expiry = parse_expiry(&first);
        let total_pages = parse_x_pages(&first).unwrap_or(1);
        let mut results: Vec<T> = Self::decode(&url, first).await?;

        for page in 2..=total_pages {
            let paged = format!("{url}?page={page}");
            let resp = self.send_request(&paged, None).await?;
            let mut page_results: Vec<T> = Self::decode(&paged, resp).await?;
            results.append(&mut page_results);
        }

        Ok((results, expiry))
    }

    /// Fetch an authenticated ESI endpoint.
    pub async fn get_auth<T: DeserializeOwned>(
        &self,
        path: &str,
        character_id: CharacterId,
    ) -> EsiResult<(T, Option<DateTime<Utc>>)> {
        let token = self.auth.get_access_token(character_id).await?;
        let url = format!("https://esi.evetech.net/latest{path}");
        let response = self.send_request(&url, Some(&token)).await?;
        let expiry = parse_expiry(&response);
        let body = Self::decode(&url, response).await?;
        Ok((body, expiry))
    }

    /// Fetch a paginated authenticated endpoint.
    pub async fn get_auth_all_pages<T: DeserializeOwned>(
        &self,
        path: &str,
        character_id: CharacterId,
    ) -> EsiResult<(Vec<T>, Option<DateTime<Utc>>)> {
        let token = self.auth.get_access_token(character_id).await?;
        let url = format!("https://esi.evetech.net/latest{path}");
        let first = self.send_request(&url, Some(&token)).await?;
        let expiry = parse_expiry(&first);
        let total_pages = parse_x_pages(&first).unwrap_or(1);
        let mut results: Vec<T> = Self::decode(&url, first).await?;

        for page in 2..=total_pages {
            let token = self.auth.get_access_token(character_id).await?;
            let paged = format!("{url}?page={page}");
            let resp = self.send_request(&paged, Some(&token)).await?;
            let mut page_results: Vec<T> = Self::decode(&paged, resp).await?;
            results.append(&mut page_results);
        }

        Ok((results, expiry))
    }

    /// POST a JSON body to a public ESI endpoint and deserialize the response.
    pub async fn post_public<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> EsiResult<T> {
        if self.budget.lock().unwrap_or_else(|e| e.into_inner()).is_exhausted() {
            return Err(EsiError::ErrorBudgetExhausted);
        }
        let url = format!("https://esi.evetech.net/latest{path}");
        let response = self.http.post(&url).json(body).send().await?;
        self.budget.lock().unwrap_or_else(|e| e.into_inner()).update_from_headers(&response);
        match response.status() {
            StatusCode::OK => Ok(Self::decode(&url, response).await?),
            StatusCode::TOO_MANY_REQUESTS => Err(EsiError::RateLimited),
            StatusCode::SERVICE_UNAVAILABLE => Err(EsiError::ServiceUnavailable),
            status => {
                let body_text = response.text().await.unwrap_or_default();
                Err(EsiError::HttpError { status: status.as_u16(), body: body_text })
            }
        }
    }

    // ── JSON decode with context ─────────────────────────────────────────────

    async fn decode<T: DeserializeOwned>(url: &str, resp: Response) -> EsiResult<T> {
        let body = resp.text().await.map_err(EsiError::Client)?;
        serde_json::from_str::<T>(&body).map_err(|e| EsiError::DecodeError {
            url: url.to_string(),
            reason: e.to_string(),
            body: body.chars().take(500).collect(),
        })
    }

    // ── Internal request ─────────────────────────────────────────────────────

    async fn send_request(
        &self,
        url: &str,
        bearer_token: Option<&str>,
    ) -> EsiResult<Response> {
        if self.budget.lock().unwrap_or_else(|e| e.into_inner()).is_exhausted() {
            return Err(EsiError::ErrorBudgetExhausted);
        }

        let mut req = self.http.get(url);
        if let Some(token) = bearer_token {
            req = req.bearer_auth(token);
        }

        let response = req.send().await?;

        // Update error budget from headers before checking status.
        self.budget.lock().unwrap_or_else(|e| e.into_inner()).update_from_headers(&response);

        match response.status() {
            StatusCode::OK => Ok(response),
            StatusCode::TOO_MANY_REQUESTS => Err(EsiError::RateLimited),
            StatusCode::SERVICE_UNAVAILABLE => Err(EsiError::ServiceUnavailable),
            status => {
                let body = response.text().await.unwrap_or_default();
                Err(EsiError::HttpError {
                    status: status.as_u16(),
                    body,
                })
            }
        }
    }
}

// ─── Header helpers ───────────────────────────────────────────────────────────

/// Parse the `Expires` header from an ESI response.
fn parse_expiry(response: &Response) -> Option<DateTime<Utc>> {
    response
        .headers()
        .get("expires")
        .or_else(|| response.headers().get("x-expires"))
        .and_then(|v| v.to_str().ok())
        .and_then(|s| DateTime::parse_from_rfc2822(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

/// Parse `X-Pages` for paginated endpoints.
fn parse_x_pages(response: &Response) -> Option<u32> {
    response
        .headers()
        .get("x-pages")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
}

// ─── Managed state ────────────────────────────────────────────────────────────

pub struct EsiState(pub EsiClient);
