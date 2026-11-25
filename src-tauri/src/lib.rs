pub mod audio;
pub mod decode;
mod extras;
mod listen;
pub mod shazam;
mod spotify;
pub mod store;

use listen::Mode;
use shazam::Song;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use store::{QueuedSignature, Settings, SpotifyTokens, Store};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

pub struct AppState {
    store: Store,
    settings: Mutex<Settings>,
    history: Mutex<Vec<Song>>,
    queue: Mutex<Vec<QueuedSignature>>,
    spotify: Mutex<SpotifyTokens>,
    http: reqwest::Client,
    /// Stop flag of the running listen session
    listening: Mutex<Option<Arc<AtomicBool>>>,
    /// Latest song, served to the OBS overlay
    current: Arc<Mutex<Option<Song>>>,
    discord: Mutex<Option<discord_rich_presence::DiscordIpcClient>>,
    overlay: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// Save, broadcast and announce a newly identified song.
pub fn deliver_song(app: &AppHandle, song: Song) {
    let state = app.state::<AppState>();
    {
        let mut h = state.history.lock().unwrap();
        store::push_history(&mut h, song.clone());
        state.store.save("history.json", &*h);
    }
    *state.current.lock().unwrap() = Some(song.clone());
    extras::discord_update(&state, Some(&song));
    app.emit("song", &song).ok();

    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if state.settings.lock().unwrap().notifications && !focused {
        app.notification().builder().title(&song.title).body(format!("{} · Black Adam", song.artist)).show().ok();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        w.unminimize().ok();
        w.show().ok();
        w.set_focus().ok();
    }
}

fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().ok();
    if hotkey.trim().is_empty() {
        return Ok(());
    }
    gs.register(hotkey.trim()).map_err(|e| format!("Can't use hotkey \"{hotkey}\": {e}"))
}

// ---------- commands ----------

#[tauri::command]
fn list_devices() -> Vec<audio::DeviceInfo> {
    audio::list_devices()
}

#[tauri::command]
fn start_listening(app: AppHandle, mode: Mode) {
    listen::start(&app, mode);
}

#[tauri::command]
fn stop_listening(app: AppHandle) {
    listen::stop(&app);
}

#[tauri::command]
fn is_listening(app: AppHandle) -> bool {
    listen::is_listening(&app)
}

#[tauri::command]
async fn identify_file(app: AppHandle, path: String) -> Result<Option<Song>, String> {
    let audio = tauri::async_runtime::spawn_blocking(move || decode::decode_middle(&path)).await.map_err(|e| e.to_string())??;
    listen::identify_samples(&app, audio, "file").await
}

#[tauri::command]
fn get_history(state: tauri::State<AppState>) -> Vec<Song> {
    state.history.lock().unwrap().clone()
}

#[tauri::command]
fn delete_song(state: tauri::State<AppState>, id: String) {
    let mut h = state.history.lock().unwrap();
    h.retain(|s| s.id != id);
    state.store.save("history.json", &*h);
}

#[tauri::command]
fn clear_history(state: tauri::State<AppState>) {
    let mut h = state.history.lock().unwrap();
    h.clear();
    state.store.save("history.json", &*h);
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let old = state.settings.lock().unwrap().clone();
    if old.hotkey != settings.hotkey {
        if let Err(e) = register_hotkey(&app, &settings.hotkey) {
            register_hotkey(&app, &old.hotkey).ok();
            return Err(e);
        }
    }
    *state.settings.lock().unwrap() = settings.clone();
    state.store.save("settings.json", &settings);
    if (old.overlay_enabled, old.overlay_port) != (settings.overlay_enabled, settings.overlay_port) {
        extras::start_overlay(&app);
    }
    if (old.discord_enabled, &old.discord_app_id) != (settings.discord_enabled, &settings.discord_app_id) {
        state.discord.lock().unwrap().take();
        let current = state.current.lock().unwrap().clone();
        extras::discord_update(&state, current.as_ref());
    }
    Ok(settings)
}

#[tauri::command]
fn queue_count(state: tauri::State<AppState>) -> usize {
    state.queue.lock().unwrap().len()
}

#[tauri::command]
async fn fetch_lyrics(state: tauri::State<'_, AppState>, title: String, artist: String) -> Result<extras::Lyrics, String> {
    extras::lyrics(&state.http, &title, &artist).await
}

#[tauri::command]
fn spotify_status(state: tauri::State<AppState>) -> bool {
    !state.spotify.lock().unwrap().refresh_token.is_empty()
}

#[tauri::command]
async fn spotify_connect(app: AppHandle) -> Result<(), String> {
    spotify::connect(&app).await
}

#[tauri::command]
fn spotify_disconnect(app: AppHandle) {
    spotify::disconnect(&app);
}

#[tauri::command]
async fn spotify_save(app: AppHandle, song: Song) -> Result<String, String> {
    spotify::save(&app, &song).await
}

#[tauri::command]
fn spotify_redirect_uri() -> &'static str {
    spotify::REDIRECT_URI
}

/// Write an export picked through the save dialog.
#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

// ---------- app ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        listen::toggle(app, Mode::Once);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let store = Store::new(app.path().app_data_dir()?);
            let settings: Settings = store.load("settings.json");
            app.manage(AppState {
                history: Mutex::new(store.load("history.json")),
                queue: Mutex::new(store.load("queue.json")),
                spotify: Mutex::new(store.load("spotify.json")),
                settings: Mutex::new(settings.clone()),
                store,
                http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?,
                listening: Mutex::new(None),
                current: Arc::new(Mutex::new(None)),
                discord: Mutex::new(None),
                overlay: Mutex::new(None),
            });
            let handle = app.handle();
            if let Err(e) = register_hotkey(handle, &settings.hotkey) {
                eprintln!("{e}");
            }
            extras::start_overlay(handle);

            // Tray
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "identify", "Identify song", true, None::<&str>)?,
                    &MenuItem::with_id(app, "live", "Live mode", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "show", "Show Black Adam", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Black Adam")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "identify" => listen::toggle(app, Mode::Once),
                    "live" => listen::toggle(app, Mode::Live),
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Launched at login: start in the tray
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    w.hide().ok();
                }
            }

            // Retry offline recordings every 45 s
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                    listen::drain_queue(&h).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppState>().settings.lock().unwrap().close_to_tray {
                    api.prevent_close();
                    window.hide().ok();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            start_listening,
            stop_listening,
            is_listening,
            identify_file,
            get_history,
            delete_song,
            clear_history,
            get_settings,
            save_settings,
            queue_count,
            fetch_lyrics,
            spotify_status,
            spotify_connect,
            spotify_disconnect,
            spotify_save,
            spotify_redirect_uri,
            save_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Black Adam");
}
