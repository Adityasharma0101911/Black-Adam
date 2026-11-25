//! Shazam recognition request. Endpoint and payload follow SongRec's
//! `communication.rs` (GPL-3.0-or-later), rewritten on reqwest.

use super::signature::Signature;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Song {
    pub id: String,
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub label: Option<String>,
    pub cover_url: Option<String>,
    pub shazam_url: Option<String>,
    pub apple_music_url: Option<String>,
    pub spotify_url: Option<String>,
    pub youtube_url: Option<String>,
    pub preview_url: Option<String>,
    /// Seconds into the track where the recorded sample starts.
    pub offset_sec: f64,
    /// Wall-clock ms when the recorded sample started (for synced lyrics).
    pub sample_start_ms: u64,
    pub identified_at: u64,
    /// "system" | "mic" | "file" | "queue"
    pub source: String,
}

#[derive(Debug)]
pub enum RecognizeError {
    /// No network: the signature can be queued and retried.
    Offline(String),
    RateLimited,
    Other(String),
}

impl std::fmt::Display for RecognizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Offline(e) => write!(f, "No internet connection ({e})"),
            Self::RateLimited => write!(f, "Shazam is rate-limiting this IP. Wait a minute and try again."),
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

const USER_AGENTS: [&str; 4] = [
    "Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)",
    "Dalvik/2.1.0 (Linux; U; Android 5.1.1; SM-J500FN Build/LMY48B)",
    "Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G930F Build/MMB29K)",
    "Dalvik/2.1.0 (Linux; U; Android 5.0.2; LG-D800 Build/LRX22G)",
];

/// Ask Shazam about a signature (given as a data URI + its length).
pub async fn recognize(http: &reqwest::Client, uri: &str, sample_ms: u32) -> Result<Option<Song>, RecognizeError> {
    let ts = now_ms();
    let body = json!({
        "geolocation": { "altitude": 300, "latitude": 45, "longitude": 2 },
        "signature": { "samplems": sample_ms, "timestamp": ts, "uri": uri },
        "timestamp": ts,
        "timezone": "Europe/Paris"
    });
    let url = format!(
        "https://amp.shazam.com/discovery/v5/en/US/android/-/tag/{}/{}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3",
        uuid::Uuid::new_v4().hyphenated().to_string().to_uppercase(),
        uuid::Uuid::new_v4().hyphenated()
    );
    let ua = USER_AGENTS[rand::random_range(0..USER_AGENTS.len())];
    let resp = http
        .post(url)
        .header("User-Agent", ua)
        .header("Content-Language", "en_US")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() || e.is_request() {
                RecognizeError::Offline(e.to_string())
            } else {
                RecognizeError::Other(e.to_string())
            }
        })?;
    if resp.status().as_u16() == 429 {
        return Err(RecognizeError::RateLimited);
    }
    if !resp.status().is_success() {
        return Err(RecognizeError::Other(format!("Shazam returned HTTP {}", resp.status())));
    }
    let v: Value = resp.json().await.map_err(|e| RecognizeError::Other(e.to_string()))?;
    Ok(parse(&v))
}

pub async fn recognize_signature(http: &reqwest::Client, sig: &Signature) -> Result<Option<Song>, RecognizeError> {
    recognize(http, &sig.encode_to_uri(), sig.sample_ms()).await
}

fn s(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(str::to_owned)
}

fn collect_uris(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                if k == "uri" {
                    if let Some(u) = val.as_str() {
                        // Shazam's Android payload wraps web links as intent://host/path#Intent;...
                        out.push(match u.strip_prefix("intent://") {
                            Some(rest) => format!("https://{}", rest.split("#Intent").next().unwrap_or(rest)),
                            None => u.to_owned(),
                        });
                    }
                }
                collect_uris(val, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_uris(x, out)),
        _ => {}
    }
}

fn enc(q: &str) -> String {
    q.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn parse(v: &Value) -> Option<Song> {
    let track = v.get("track")?;
    let title = s(&track["title"])?;
    let artist = s(&track["subtitle"]).unwrap_or_else(|| "Unknown artist".into());

    let meta = |name: &str| -> Option<String> {
        track["sections"].as_array()?.iter().find_map(|sec| {
            sec["metadata"].as_array()?.iter().find(|m| m["title"] == name).and_then(|m| s(&m["text"]))
        })
    };
    let (album, label, year) = (meta("Album"), meta("Label"), meta("Released"));

    let mut uris = vec![];
    collect_uris(&track["hub"], &mut uris);
    let find = |pred: &dyn Fn(&str) -> bool| uris.iter().find(|u| pred(u)).cloned();
    let query = enc(&format!("{title} {artist}"));

    Some(Song {
        id: uuid::Uuid::new_v4().to_string(),
        key: s(&track["key"]).unwrap_or_else(|| format!("{title}|{artist}")),
        genre: s(&track["genres"]["primary"]),
        cover_url: s(&track["images"]["coverarthq"]).or_else(|| s(&track["images"]["coverart"])),
        shazam_url: s(&track["url"]),
        apple_music_url: find(&|u| u.contains("music.apple.com")),
        preview_url: find(&|u| u.starts_with("http") && (u.contains(".m4a") || u.contains("audio-ssl"))),
        spotify_url: Some(format!("https://open.spotify.com/search/{query}")),
        youtube_url: find(&|u| u.contains("music.youtube.com"))
            .or_else(|| Some(format!("https://www.youtube.com/results?search_query={query}"))),
        offset_sec: v["matches"][0]["offset"].as_f64().unwrap_or(0.0),
        identified_at: now_ms(),
        title,
        artist,
        album,
        label,
        year,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_shazam_match() {
        let v = json!({
            "matches": [{ "offset": 42.5 }],
            "track": {
                "key": "123", "title": "Song", "subtitle": "Artist", "url": "https://shazam.com/track/123",
                "genres": { "primary": "Pop" },
                "images": { "coverart": "https://img/c.jpg", "coverarthq": "https://img/hq.jpg" },
                "sections": [{ "type": "SONG", "metadata": [
                    { "title": "Album", "text": "LP" }, { "title": "Label", "text": "Lbl" }, { "title": "Released", "text": "2020" }
                ]}],
                "hub": {
                    "actions": [{ "type": "uri", "uri": "https://audio-ssl.itunes.apple.com/x.m4a" }],
                    "options": [{ "actions": [{ "uri": "intent://music.apple.com/album/1#Intent;scheme=http;end" }] }]
                }
            }
        });
        let song = parse(&v).unwrap();
        assert_eq!((song.title.as_str(), song.artist.as_str()), ("Song", "Artist"));
        assert_eq!(song.album.as_deref(), Some("LP"));
        assert_eq!(song.year.as_deref(), Some("2020"));
        assert_eq!(song.label.as_deref(), Some("Lbl"));
        assert_eq!(song.genre.as_deref(), Some("Pop"));
        assert_eq!(song.cover_url.as_deref(), Some("https://img/hq.jpg"));
        assert_eq!(song.preview_url.as_deref(), Some("https://audio-ssl.itunes.apple.com/x.m4a"));
        assert_eq!(song.apple_music_url.as_deref(), Some("https://music.apple.com/album/1"));
        assert_eq!(song.spotify_url.as_deref(), Some("https://open.spotify.com/search/Song%20Artist"));
        assert_eq!(song.offset_sec, 42.5);
    }

    #[test]
    fn no_track_means_no_match() {
        assert!(parse(&json!({ "matches": [], "retryms": 1000 })).is_none());
    }
}
