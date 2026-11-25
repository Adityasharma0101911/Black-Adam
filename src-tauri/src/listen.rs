//! The listening loop: progressive recognition (try at 3, 6, 9, 12 s), live mode
//! with de-duplication and back-off, offline queueing, and a ~30 fps visualizer tick.

use crate::audio::{Capture, Visualizer};
use crate::shazam::{RecognizeError, Song, now_ms, recognize, signature};
use crate::store::QueuedSignature;
use crate::{AppState, deliver_song};
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Debug, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Once,
    Live,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tick<'a> {
    /// "listening" | "matching" | "cooldown"
    phase: &'a str,
    mode: Mode,
    level: f32,
    bands: Vec<f32>,
    /// 0..1 of the current attempt window
    progress: f32,
    cooldown_secs: u32,
    device: &'a str,
    kind: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListenResult {
    /// "no-match" | "error" | "queued" | "silent"
    pub status: String,
    pub message: String,
}

fn result(app: &AppHandle, status: &str, message: impl Into<String>) {
    app.emit("listen-result", ListenResult { status: status.into(), message: message.into() }).ok();
}

pub fn is_listening(app: &AppHandle) -> bool {
    app.state::<AppState>().listening.lock().unwrap().is_some()
}

pub fn stop(app: &AppHandle) {
    if let Some(flag) = app.state::<AppState>().listening.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Start listening, or stop if already listening.
pub fn toggle(app: &AppHandle, mode: Mode) {
    if is_listening(app) {
        stop(app);
    } else {
        start(app, mode);
    }
}

pub fn start(app: &AppHandle, mode: Mode) {
    stop(app);
    let flag = Arc::new(AtomicBool::new(false));
    *app.state::<AppState>().listening.lock().unwrap() = Some(flag.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        run(&app, mode, &flag);
        let state = app.state::<AppState>();
        let mut cur = state.listening.lock().unwrap();
        if cur.as_ref().is_some_and(|f| Arc::ptr_eq(f, &flag)) {
            *cur = None;
        }
        drop(cur);
        app.emit("listen-stopped", ()).ok();
    });
}

/// Attempt times in seconds: every 3 s up to `max`, always ending at `max`.
pub fn checkpoints(max: u32) -> Vec<f32> {
    let max = max.clamp(3, 30);
    let mut cps: Vec<f32> = (1..).map(|i| i as f32 * 3.0).take_while(|c| *c < max as f32).collect();
    cps.push(max as f32);
    cps
}

type Pending = (tauri::async_runtime::JoinHandle<Result<Option<Song>, RecognizeError>>, u64, String, u32);

fn run(app: &AppHandle, mode: Mode, stop: &AtomicBool) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let cap = match Capture::start(settings.device_id.as_deref()) {
        Ok(c) => c,
        Err(e) => return result(app, "error", e),
    };
    let max = settings.max_listen_secs.clamp(3, 30);
    let cps = checkpoints(max);
    let http = state.http.clone();
    let mut viz = Visualizer::new();
    let mut next_cp = 0usize;
    let mut cooldown_until: Option<Instant> = None;
    let mut pending: Option<Pending> = None;
    let mut last_key: Option<String> = None;
    let mut backoff = 30u64;
    let mut heard_sound = false;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(33));
        let (level, bands) = cap.frame(&mut viz);
        heard_sound |= level > 0.004;

        let cooldown = |secs: u64, until: &mut Option<Instant>| *until = Some(Instant::now() + Duration::from_secs(secs));

        // Cooldown between live-mode attempts
        if let Some(until) = cooldown_until {
            if Instant::now() >= until {
                cooldown_until = None;
                cap.reset();
                next_cp = 0;
                heard_sound = false;
            }
        }

        // A recognition request finished?
        if pending.as_ref().is_some_and(|p| p.0.inner().is_finished()) {
            let (handle, sample_start, uri, sample_ms) = pending.take().unwrap();
            let res = tauri::async_runtime::block_on(handle).unwrap_or_else(|e| Err(RecognizeError::Other(e.to_string())));
            let last_attempt = next_cp >= cps.len();
            match res {
                Ok(Some(mut song)) => {
                    song.sample_start_ms = sample_start;
                    song.source = cap.kind.into();
                    backoff = 30;
                    // Live mode: same song still playing, don't log it twice
                    if mode == Mode::Once || last_key.as_deref() != Some(song.key.as_str()) {
                        last_key = Some(song.key.clone());
                        deliver_song(app, song);
                    }
                    if mode == Mode::Once {
                        break;
                    }
                    cooldown(20, &mut cooldown_until);
                }
                Ok(None) if !last_attempt => {}
                Ok(None) => {
                    if mode == Mode::Once {
                        if heard_sound {
                            result(app, "no-match", "Couldn't find a match. Try again during a clearer part of the song.");
                        } else {
                            result(app, "silent", format!("No sound coming from {}. Is something playing?", cap.device_name));
                        }
                        break;
                    }
                    cooldown(4, &mut cooldown_until);
                }
                Err(RecognizeError::Offline(_)) => {
                    let mut q = state.queue.lock().unwrap();
                    q.push(QueuedSignature { uri, sample_ms, captured_at: sample_start, source: cap.kind.into() });
                    state.store.save("queue.json", &*q);
                    app.emit("queue-updated", q.len()).ok();
                    drop(q);
                    result(app, "queued", "You're offline. Saved the recording and will identify it when you're back online.");
                    if mode == Mode::Once {
                        break;
                    }
                    cooldown(60, &mut cooldown_until);
                }
                Err(RecognizeError::RateLimited) => {
                    result(app, "error", RecognizeError::RateLimited.to_string());
                    if mode == Mode::Once {
                        break;
                    }
                    cooldown(backoff, &mut cooldown_until);
                    backoff = (backoff * 2).min(300);
                }
                Err(e) => {
                    result(app, "error", e.to_string());
                    if mode == Mode::Once {
                        break;
                    }
                    cooldown(10, &mut cooldown_until);
                }
            }
        }

        // Time for the next attempt?
        if cooldown_until.is_none() && pending.is_none() && next_cp < cps.len() && cap.seconds() >= cps[next_cp] {
            next_cp += 1;
            let (audio, start) = cap.last_16k(12.0);
            let sig = signature::from_samples(&audio);
            let (uri, ms) = (sig.encode_to_uri(), sig.sample_ms());
            let (http, uri2) = (http.clone(), uri.clone());
            // Silence has no peaks: don't bother Shazam with it
            let silent = sig.peak_count() == 0;
            let handle = tauri::async_runtime::spawn(async move { if silent { Ok(None) } else { recognize(&http, &uri2, ms).await } });
            pending = Some((handle, start, uri, ms));
        }

        let phase = if cooldown_until.is_some() { "cooldown" } else if pending.is_some() { "matching" } else { "listening" };
        app.emit(
            "tick",
            Tick {
                phase,
                mode,
                level,
                bands,
                progress: if cooldown_until.is_some() { 1.0 } else { (cap.seconds() / max as f32).min(1.0) },
                cooldown_secs: cooldown_until.map(|u| u.saturating_duration_since(Instant::now()).as_secs() as u32 + 1).unwrap_or(0),
                device: &cap.device_name,
                kind: cap.kind,
            },
        )
        .ok();
    }
}

/// Retry signatures recorded while offline. Called periodically.
pub async fn drain_queue(app: &AppHandle) {
    let state = app.state::<AppState>();
    let items = state.queue.lock().unwrap().clone();
    if items.is_empty() {
        return;
    }
    let mut done = 0;
    for item in &items {
        match recognize(&state.http, &item.uri, item.sample_ms).await {
            Ok(found) => {
                done += 1;
                if let Some(mut song) = found {
                    song.identified_at = item.captured_at;
                    song.source = "queue".into();
                    deliver_song(app, song);
                }
            }
            Err(RecognizeError::Offline(_)) | Err(RecognizeError::RateLimited) => break,
            Err(_) => done += 1, // drop items Shazam rejects
        }
    }
    let mut q = state.queue.lock().unwrap();
    let n = done.min(q.len());
    q.drain(..n);
    state.store.save("queue.json", &*q);
    app.emit("queue-updated", q.len()).ok();
}

pub async fn identify_samples(app: &AppHandle, audio: Vec<f32>, source: &str) -> Result<Option<Song>, String> {
    let state = app.state::<AppState>();
    let sig = signature::from_samples(&audio);
    let (uri, ms) = (sig.encode_to_uri(), sig.sample_ms());
    match recognize(&state.http, &uri, ms).await {
        Ok(Some(mut song)) => {
            song.source = source.into();
            deliver_song(app, song.clone());
            Ok(Some(song))
        }
        Ok(None) => Ok(None),
        Err(RecognizeError::Offline(_)) => {
            let mut q = state.queue.lock().unwrap();
            q.push(QueuedSignature { uri, sample_ms: ms, captured_at: now_ms(), source: source.into() });
            state.store.save("queue.json", &*q);
            app.emit("queue-updated", q.len()).ok();
            Err("You're offline. Saved it and will identify it when you're back online.".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::checkpoints;

    #[test]
    fn checkpoints_step_by_three_and_end_at_max() {
        assert_eq!(checkpoints(12), vec![3.0, 6.0, 9.0, 12.0]);
        assert_eq!(checkpoints(10), vec![3.0, 6.0, 9.0, 10.0]);
        assert_eq!(checkpoints(1), vec![3.0]);
    }
}
