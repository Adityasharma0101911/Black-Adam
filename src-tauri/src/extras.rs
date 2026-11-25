//! Lyrics (LRCLIB), Discord Rich Presence, and the OBS "now playing" overlay.

use crate::AppState;
use crate::shazam::Song;
use discord_rich_presence::{DiscordIpc, DiscordIpcClient, activity};
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const USER_AGENT: &str = "Black Adam (https://github.com/Adityasharma0101911/Black-Adam)";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// LRC text with [mm:ss.xx] timestamps
    pub synced: Option<String>,
    pub plain: Option<String>,
}

pub async fn lyrics(http: &reqwest::Client, title: &str, artist: &str) -> Result<Lyrics, String> {
    let list: Vec<Value> = http
        .get("https://lrclib.net/api/search")
        .header("User-Agent", USER_AGENT)
        .query(&[("track_name", title), ("artist_name", artist)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let pick = list.iter().find(|l| l["syncedLyrics"].is_string()).or_else(|| list.first());
    Ok(pick
        .map(|l| Lyrics {
            synced: l["syncedLyrics"].as_str().map(str::to_owned),
            plain: l["plainLyrics"].as_str().map(str::to_owned),
        })
        .unwrap_or_default())
}

/// Show "Listening to <title> by <artist>" on Discord.
pub fn discord_update(state: &AppState, song: Option<&Song>) {
    let settings = state.settings.lock().unwrap().clone();
    let mut slot = state.discord.lock().unwrap();
    if !settings.discord_enabled || settings.discord_app_id.trim().is_empty() {
        if let Some(mut c) = slot.take() {
            c.close().ok();
        }
        return;
    }
    if slot.is_none() {
        let mut c = DiscordIpcClient::new(settings.discord_app_id.trim());
        if c.connect().is_err() {
            return; // Discord not running
        }
        *slot = Some(c);
    }
    let client = slot.as_mut().unwrap();
    let res = match song {
        Some(s) => {
            let mut assets = activity::Assets::new().large_text(s.album.as_deref().unwrap_or(&s.title));
            if let Some(c) = &s.cover_url {
                assets = assets.large_image(c);
            }
            let mut a = activity::Activity::new()
                .activity_type(activity::ActivityType::Listening)
                .details(&s.title)
                .state(&s.artist)
                .assets(assets);
            if let Some(u) = &s.shazam_url {
                a = a.buttons(vec![activity::Button::new("Open in Shazam", u)]);
            }
            client.set_activity(a)
        }
        None => client.clear_activity(),
    };
    if res.is_err() {
        slot.take(); // reconnect next time
    }
}

const OVERLAY_HTML: &str = include_str!("overlay.html");

/// Serve the overlay page and /now JSON on 127.0.0.1:<port> until aborted.
pub fn start_overlay(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    if let Some(h) = state.overlay.lock().unwrap().take() {
        h.abort();
    }
    if !settings.overlay_enabled {
        return;
    }
    let current: Arc<Mutex<Option<Song>>> = state.current.clone();
    let port = settings.overlay_port;
    let handle = tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await else {
            eprintln!("overlay: port {port} is in use");
            return;
        };
        while let Ok((mut sock, _)) = listener.accept().await {
            let current = current.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/");
                let (ctype, body) = if path.starts_with("/now") {
                    ("application/json", serde_json::to_string(&*current.lock().unwrap()).unwrap_or_else(|_| "null".into()))
                } else {
                    ("text/html; charset=utf-8", OVERLAY_HTML.to_owned())
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(resp.as_bytes()).await.ok();
            });
        }
    });
    *state.overlay.lock().unwrap() = Some(handle);
}
