//! "Save to Spotify": PKCE login through a loopback redirect, then add the
//! identified track to a private "Black Adam" playlist.
//! Needs a Spotify app (developer.spotify.com) with redirect URI REDIRECT_URI.

use crate::AppState;
use crate::shazam::{Song, now_ms};
use crate::store::SpotifyTokens;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const REDIRECT_URI: &str = "http://127.0.0.1:8898/callback";
const SCOPES: &str = "playlist-modify-private playlist-modify-public";

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn client_id(state: &AppState) -> Result<String, String> {
    let id = state.settings.lock().unwrap().spotify_client_id.trim().to_owned();
    if id.is_empty() { Err("Add your Spotify Client ID in Settings first.".into()) } else { Ok(id) }
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> Result<SpotifyTokens, String> {
    let v: Value = http
        .post("https://accounts.spotify.com/api/token")
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let access = v["access_token"].as_str().ok_or_else(|| format!("Spotify login failed: {}", v["error_description"].as_str().unwrap_or("unknown error")))?;
    Ok(SpotifyTokens {
        access_token: access.into(),
        refresh_token: v["refresh_token"].as_str().unwrap_or_default().into(),
        expires_at: now_ms() + v["expires_in"].as_u64().unwrap_or(3600) * 1000 - 60_000,
    })
}

/// Open the browser for login and wait (up to 3 minutes) for the redirect.
pub async fn connect(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let id = client_id(&state)?;
    let verifier = b64url(&rand::random::<[u8; 48]>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let st = b64url(&rand::random::<[u8; 16]>());
    let url = reqwest::Url::parse_with_params(
        "https://accounts.spotify.com/authorize",
        &[("client_id", id.as_str()), ("response_type", "code"), ("redirect_uri", REDIRECT_URI), ("scope", SCOPES),
          ("code_challenge_method", "S256"), ("code_challenge", challenge.as_str()), ("state", st.as_str())],
    )
    .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8898").await.map_err(|e| format!("Port 8898 is busy: {e}"))?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    let code = tokio::time::timeout(std::time::Duration::from_secs(180), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("").to_owned();
            if !path.starts_with("/callback") {
                continue;
            }
            let q = reqwest::Url::parse(&format!("http://x{path}")).map_err(|e| e.to_string())?;
            let get = |k: &str| q.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.to_string());
            let ok = get("state").as_deref() == Some(st.as_str()) && get("code").is_some();
            let msg = if ok { "Connected to Black Adam. You can close this tab." } else { "Spotify login was cancelled." };
            let body = format!("<html><body style='font-family:system-ui;background:#0a0a0a;color:#fbbf24;display:grid;place-items:center;height:100vh'><h2>{msg}</h2></body></html>");
            sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.ok();
            return if ok { Ok(get("code").unwrap()) } else { Err("Spotify login was cancelled.".to_string()) };
        }
    })
    .await
    .map_err(|_| "Spotify login timed out.".to_string())??;

    let tokens = token_request(&state.http, &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT_URI), ("client_id", &id), ("code_verifier", &verifier)]).await?;
    state.store.save("spotify.json", &tokens);
    *state.spotify.lock().unwrap() = tokens;
    Ok(())
}

pub fn disconnect(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.spotify.lock().unwrap() = SpotifyTokens::default();
    state.store.save("spotify.json", &SpotifyTokens::default());
}

async fn access_token(state: &AppState) -> Result<String, String> {
    let t = state.spotify.lock().unwrap().clone();
    if t.refresh_token.is_empty() && t.access_token.is_empty() {
        return Err("Connect Spotify in Settings first.".into());
    }
    if now_ms() < t.expires_at {
        return Ok(t.access_token);
    }
    let id = client_id(state)?;
    let mut fresh = token_request(&state.http, &[("grant_type", "refresh_token"), ("refresh_token", &t.refresh_token), ("client_id", &id)]).await?;
    if fresh.refresh_token.is_empty() {
        fresh.refresh_token = t.refresh_token;
    }
    state.store.save("spotify.json", &fresh);
    *state.spotify.lock().unwrap() = fresh.clone();
    Ok(fresh.access_token)
}

async fn api(state: &AppState, method: reqwest::Method, url: &str, body: Option<Value>) -> Result<Value, String> {
    let token = access_token(state).await?;
    let mut req = state.http.request(method, url).bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("Spotify error {status}: {}", v["error"]["message"].as_str().unwrap_or("request failed")));
    }
    Ok(v)
}

/// Find the song on Spotify and add it to the Black Adam playlist. Returns the track name.
pub async fn save(app: &AppHandle, song: &Song) -> Result<String, String> {
    let state = app.state::<AppState>();
    let q = format!("track:{} artist:{}", song.title, song.artist);
    let search = reqwest::Url::parse_with_params("https://api.spotify.com/v1/search", &[("q", q.as_str()), ("type", "track"), ("limit", "1")]).unwrap();
    let found = api(&state, reqwest::Method::GET, search.as_str(), None).await?;
    let track = &found["tracks"]["items"][0];
    let uri = track["uri"].as_str().ok_or("Couldn't find this song on Spotify.")?.to_owned();

    let playlist = state.settings.lock().unwrap().spotify_playlist_id.clone();
    let playlist = match playlist {
        Some(p) => p,
        None => {
            let me = api(&state, reqwest::Method::GET, "https://api.spotify.com/v1/me", None).await?;
            let user = me["id"].as_str().ok_or("Couldn't read your Spotify profile.")?;
            let created = api(&state, reqwest::Method::POST, &format!("https://api.spotify.com/v1/users/{user}/playlists"),
                Some(json!({ "name": "Black Adam", "public": false, "description": "Songs identified with Black Adam" }))).await?;
            let id = created["id"].as_str().ok_or("Couldn't create the playlist.")?.to_owned();
            let mut s = state.settings.lock().unwrap();
            s.spotify_playlist_id = Some(id.clone());
            state.store.save("settings.json", &*s);
            id
        }
    };
    api(&state, reqwest::Method::POST, &format!("https://api.spotify.com/v1/playlists/{playlist}/tracks"), Some(json!({ "uris": [uri] }))).await?;
    Ok(track["name"].as_str().unwrap_or(&song.title).to_owned())
}
