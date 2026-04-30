//! Opt-in anonymous analytics ping.
//! Fires on app launch if the user has opted in during first-run setup.
//! Sends a single anonymous request to Plausible — no personal or in-game
//! data. Respects the CCP DLA opt-in requirement.
//! If the user has not yet decided (Pending), does nothing.

use crate::db::local::AnalyticsConsent;

/// Plausible analytics endpoint.
const PLAUSIBLE_URL: &str = "https://eve-nexus-analytics.fly.dev/api/event";

/// Plausible site domain — must match what is configured in Plausible.
const SITE_DOMAIN: &str = "app.eve-nexus.app";

/// App version sourced from Cargo at compile time.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Fire the launch ping if the user has opted in.
///
/// Consent is resolved before spawning so we don't need to pass a `LocalDb`
/// reference across the async boundary.  Failures are silently ignored —
/// analytics must never affect app stability.
pub async fn maybe_ping_launch(consent: AnalyticsConsent, device_id: String) {
    if consent != AnalyticsConsent::Granted {
        return;
    }
    let _ = send_ping("pageview", "/launch", &device_id).await;
}

/// Send a single Plausible event.
///
/// Props carry the app version and a stable anonymous device ID so monthly
/// unique users can be counted accurately across multiple daily launches.
async fn send_ping(event_name: &str, page: &str, device_id: &str) -> Result<(), reqwest::Error> {
    let url = format!("app://{SITE_DOMAIN}{page}");

    let body = serde_json::json!({
        "name":   event_name,
        "url":    url,
        "domain": SITE_DOMAIN,
        "props":  {
            "version":   APP_VERSION,
            "device_id": device_id,
        },
    });

    reqwest::Client::new()
        .post(PLAUSIBLE_URL)
        .header("Content-Type", "application/json")
        .header("User-Agent", format!("eve-nexus/{APP_VERSION}"))
        .json(&body)
        .send()
        .await?;

    Ok(())
}
