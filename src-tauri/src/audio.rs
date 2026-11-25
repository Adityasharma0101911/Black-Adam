//! Audio devices and capture. System audio uses loopback (WASAPI on Windows,
//! a CoreAudio tap on macOS 14.2+, PulseAudio monitor sources on Linux).

use crate::shazam::{now_ms, signature};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use realfft::RealFftPlanner;
use serde::Serialize;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    /// "system" (what your computer plays) or "mic"
    pub kind: String,
    pub is_default: bool,
}

const LINUX: bool = cfg!(target_os = "linux");

fn name_of(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_owned()).unwrap_or_else(|_| "Unknown device".into())
}

fn id_of(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|i| i.to_string())
}

fn kind_of(d: &cpal::Device, from_outputs: bool) -> &'static str {
    if from_outputs || (LINUX && name_of(d).to_lowercase().contains("monitor")) { "system" } else { "mic" }
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let def_out = host.default_output_device().and_then(|d| id_of(&d));
    let def_in = host.default_input_device().and_then(|d| id_of(&d));
    let mut out = vec![];
    if !LINUX {
        for d in host.output_devices().into_iter().flatten() {
            if let Some(id) = id_of(&d) {
                out.push(DeviceInfo { is_default: def_out.as_ref() == Some(&id), id, name: name_of(&d), kind: "system".into() });
            }
        }
    }
    for d in host.input_devices().into_iter().flatten() {
        if let Some(id) = id_of(&d) {
            let kind = kind_of(&d, false);
            out.push(DeviceInfo { is_default: kind == "mic" && def_in.as_ref() == Some(&id), id, name: name_of(&d), kind: kind.into() });
        }
    }
    // System sources first, defaults first within each group
    out.sort_by_key(|d| (d.kind != "system", !d.is_default));
    out
}

/// Pick the requested device, or the best system-audio source.
fn resolve(id: Option<&str>) -> Result<(cpal::Device, &'static str), String> {
    let host = cpal::default_host();
    if let Some(dev) = id.and_then(|i| cpal::DeviceId::from_str(i).ok()).and_then(|i| host.device_by_id(&i)) {
        let from_outputs = !LINUX && host.output_devices().into_iter().flatten().any(|o| o.id().ok() == dev.id().ok());
        return Ok((dev.clone(), kind_of(&dev, from_outputs)));
    }
    if !LINUX {
        if let Some(d) = host.default_output_device() {
            return Ok((d, "system"));
        }
    }
    if let Some(d) = host.input_devices().into_iter().flatten().find(|d| kind_of(d, false) == "system") {
        return Ok((d, "system"));
    }
    host.default_input_device()
        .map(|d| (d, "mic"))
        .ok_or_else(|| "No audio device found. Plug in speakers/headphones or a microphone.".into())
}

struct Shared {
    mono: Vec<f32>,
    /// Wall-clock ms of mono[0]
    start_ms: u64,
    level: f32,
    /// Windows loopback delivers nothing during silence, so time comes from the clock
    reset_at: std::time::Instant,
    last_callback: std::time::Instant,
}

pub struct Capture {
    _stream: cpal::Stream,
    shared: Arc<Mutex<Shared>>,
    rate: u32,
    pub kind: &'static str,
    pub device_name: String,
}

impl Capture {
    pub fn start(device_id: Option<&str>) -> Result<Self, String> {
        let (device, kind) = resolve(device_id)?;
        let use_output_cfg = kind == "system" && !LINUX;
        let cfg = if use_output_cfg { device.default_output_config() } else { device.default_input_config() }
            .map_err(|e| format!("Can't read device format: {e}"))?;
        let rate = cfg.sample_rate();
        let channels = cfg.channels() as usize;
        let shared = Arc::new(Mutex::new(Shared { mono: vec![], start_ms: now_ms(), level: 0.0, reset_at: std::time::Instant::now(), last_callback: std::time::Instant::now() }));
        let stream_cfg: cpal::StreamConfig = cfg.clone().into();

        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => build::<f32>(&device, &stream_cfg, channels, rate, shared.clone()),
            cpal::SampleFormat::I16 => build::<i16>(&device, &stream_cfg, channels, rate, shared.clone()),
            cpal::SampleFormat::U16 => build::<u16>(&device, &stream_cfg, channels, rate, shared.clone()),
            cpal::SampleFormat::I32 => build::<i32>(&device, &stream_cfg, channels, rate, shared.clone()),
            f => return Err(format!("Unsupported sample format {f}")),
        }
        .map_err(|e| {
            if kind == "mic" { format!("Can't open the microphone ({e}). Check microphone permissions.") } else { format!("Can't capture system audio ({e}).") }
        })?;
        stream.play().map_err(|e| format!("Can't start capture: {e}"))?;
        Ok(Self { _stream: stream, shared, rate, kind, device_name: name_of(&device) })
    }

    /// Forget what was captured so far (start of a new recognition window).
    pub fn reset(&self) {
        let mut s = self.shared.lock().unwrap();
        s.mono.clear();
        s.start_ms = now_ms();
        s.reset_at = std::time::Instant::now();
    }

    /// Seconds since the last reset (wall clock, not samples received).
    pub fn seconds(&self) -> f32 {
        self.shared.lock().unwrap().reset_at.elapsed().as_secs_f32()
    }

    pub fn captured_seconds(&self) -> f32 {
        self.shared.lock().unwrap().mono.len() as f32 / self.rate as f32
    }

    /// The last `secs` seconds as mono 16 kHz, plus the wall-clock ms where it starts.
    pub fn last_16k(&self, secs: f32) -> (Vec<f32>, u64) {
        let s = self.shared.lock().unwrap();
        let n = ((secs * self.rate as f32) as usize).min(s.mono.len());
        let skip = s.mono.len() - n;
        let start = s.start_ms + (skip as f64 * 1000.0 / self.rate as f64) as u64;
        (signature::resample(&s.mono[skip..], self.rate), start)
    }

    /// Level (0..1) and 48 log-spaced spectrum bands (0..1) for the visualizer.
    pub fn frame(&self, fft: &mut Visualizer) -> (f32, Vec<f32>) {
        let mut s = self.shared.lock().unwrap();
        s.level *= 0.9; // no callbacks during silence on Windows loopback
        let n = s.mono.len();
        let stale = s.last_callback.elapsed().as_millis() > 150;
        let take = if stale { 0 } else { 2048.min(n) };
        let window = &s.mono[n - take..];
        (s.level, fft.bands(window, self.rate))
    }
}

fn build<T>(device: &cpal::Device, cfg: &cpal::StreamConfig, channels: usize, rate: u32, shared: Arc<Mutex<Shared>>) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let max_len = rate as usize * 20; // keep at most 20 s
    device.build_input_stream::<T, _, _>(
        cfg.clone(),
        move |data: &[T], _| {
            let mut s = shared.lock().unwrap();
            if s.mono.is_empty() {
                s.start_ms = now_ms(); // first audio after silence
            }
            s.last_callback = std::time::Instant::now();
            let mut peak = 0.0f32;
            for frame in data.chunks(channels.max(1)) {
                let v = frame.iter().map(|x| <f32 as FromSample<T>>::from_sample_(*x)).sum::<f32>() / frame.len() as f32;
                peak = peak.max(v.abs());
                s.mono.push(v);
            }
            s.level = s.level * 0.7 + peak.min(1.0) * 0.3;
            if s.mono.len() > max_len {
                let drop = s.mono.len() - max_len;
                s.mono.drain(..drop);
                s.start_ms += (drop as f64 * 1000.0 / rate as f64) as u64;
            }
        },
        |e| eprintln!("audio stream error: {e}"),
        None,
    )
}

pub struct Visualizer {
    planner: RealFftPlanner<f32>,
    smooth: Vec<f32>,
}

impl Visualizer {
    pub const BANDS: usize = 48;

    pub fn new() -> Self {
        Self { planner: RealFftPlanner::new(), smooth: vec![0.0; Self::BANDS] }
    }

    fn bands(&mut self, window: &[f32], rate: u32) -> Vec<f32> {
        if window.len() < 2048 {
            self.smooth.iter_mut().for_each(|v| *v *= 0.85);
            return self.smooth.clone();
        }
        let fft = self.planner.plan_fft_forward(2048);
        let mut input: Vec<f32> = window
            .iter()
            .enumerate()
            .map(|(i, x)| x * (0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / 2047.0).cos()))
            .collect();
        let mut spec = fft.make_output_vec();
        fft.process(&mut input, &mut spec).ok();
        let bin_hz = rate as f32 / 2048.0;
        let (lo, hi) = (40.0f32, 12000.0f32.min(rate as f32 / 2.0));
        for b in 0..Self::BANDS {
            let f0 = lo * (hi / lo).powf(b as f32 / Self::BANDS as f32);
            let f1 = lo * (hi / lo).powf((b + 1) as f32 / Self::BANDS as f32);
            let i0 = ((f0 / bin_hz) as usize).min(1024);
            let i1 = ((f1 / bin_hz) as usize).max(i0 + 1).min(1025);
            let mag = spec[i0..i1].iter().map(|c| c.norm()).fold(0.0f32, f32::max);
            let db = (20.0 * (mag / 64.0 + 1e-6).log10() + 60.0) / 60.0; // ~-60..0 dB -> 0..1
            let v = db.clamp(0.0, 1.0);
            // fast attack, slow release
            self.smooth[b] = if v > self.smooth[b] { v } else { self.smooth[b] * 0.82 + v * 0.18 };
        }
        self.smooth.clone()
    }
}
