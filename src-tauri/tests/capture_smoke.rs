// Needs a real audio device; run manually: cargo test --test capture_smoke -- --ignored --nocapture
#[test]
#[ignore]
fn captures_from_default_system_device() {
    for d in black_adam_lib::audio::list_devices() {
        println!("{d:?}");
    }
    let cap = black_adam_lib::audio::Capture::start(None).expect("capture");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let (audio, _) = cap.last_16k(12.0);
    println!("{} ({}): {:.2}s elapsed, {:.2}s captured, {} samples at 16 kHz", cap.device_name, cap.kind, cap.seconds(), cap.captured_seconds(), audio.len());
    assert!(cap.seconds() > 1.0, "clock should advance even in silence");
}

// Play a song on the speakers first; run: cargo test --test capture_smoke loopback_identifies -- --ignored --nocapture
#[test]
#[ignore]
fn loopback_identifies_playing_song() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    // Play the song (mono 16 kHz from the decoder) on the default output at low volume
    let path = std::env::var("BLACK_ADAM_TEST_SONG").expect("set BLACK_ADAM_TEST_SONG to an audio file");
    let song_audio = black_adam_lib::decode::decode_middle(&path).expect("decode");
    let out = cpal::default_host().default_output_device().expect("output");
    let cfg = out.default_output_config().unwrap();
    let (rate, ch) = (cfg.sample_rate() as f64, cfg.channels() as usize);
    let mut pos = 0f64;
    let stream = out
        .build_output_stream::<f32, _, _>(cfg.into(), move |buf: &mut [f32], _| {
            for frame in buf.chunks_mut(ch) {
                let v = song_audio.get(pos as usize).copied().unwrap_or(0.0) * 0.35;
                frame.iter_mut().for_each(|x| *x = v);
                pos += 16000.0 / rate;
            }
        }, |e| eprintln!("{e}"), None)
        .unwrap();
    stream.play().unwrap();
    let cap = black_adam_lib::audio::Capture::start(None).expect("capture");
    std::thread::sleep(std::time::Duration::from_secs(8));
    let (audio, _) = cap.last_16k(12.0);
    let sig = black_adam_lib::shazam::signature::from_samples(&audio);
    println!("captured {:.1}s, {} peaks", cap.captured_seconds(), sig.peak_count());
    let song = tauri::async_runtime::block_on(black_adam_lib::shazam::recognize_signature(&reqwest::Client::new(), &sig)).expect("request");
    let song = song.expect("no match");
    println!("MATCH via loopback: {} - {}", song.title, song.artist);
}

// Dev helper: play BLACK_ADAM_TEST_SONG on the speakers for 20 s (to try the app by hand)
#[test]
#[ignore]
fn play_test_song() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let path = std::env::var("BLACK_ADAM_TEST_SONG").expect("set BLACK_ADAM_TEST_SONG");
    let audio = black_adam_lib::decode::decode_middle(&path).expect("decode");
    let out = cpal::default_host().default_output_device().unwrap();
    let cfg = out.default_output_config().unwrap();
    let (rate, ch) = (cfg.sample_rate() as f64, cfg.channels() as usize);
    let mut pos = 0f64;
    let s = out.build_output_stream::<f32, _, _>(cfg.into(), move |buf: &mut [f32], _| {
        for f in buf.chunks_mut(ch) {
            let v = audio.get(pos as usize).copied().unwrap_or(0.0) * 0.35;
            f.iter_mut().for_each(|x| *x = v);
            pos += 16000.0 / rate;
        }
    }, |e| eprintln!("{e}"), None).unwrap();
    s.play().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(12));
}
