//! Shazam audio signature generation.
//!
//! Adapted from SongRec by Marin M. (https://github.com/marin-m/SongRec),
//! `src/core/fingerprinting/{algorithm,signature_format}.rs`, GPL-3.0-or-later.

use base64::Engine;
use byteorder::{LittleEndian, WriteBytesExt};
use realfft::RealFftPlanner;
use realfft::num_complex::Complex;
use std::io::{Cursor, Seek, SeekFrom, Write};
use std::sync::LazyLock;

pub const SAMPLE_RATE: u32 = 16_000;

/// numpy.hanning(2050)[1:-1]: a 2048-point Hann window without its zero endpoints.
static HANNING: LazyLock<[f32; 2048]> = LazyLock::new(|| {
    std::array::from_fn(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i + 1) as f64 / 2049.0).cos()) as f32)
});

struct FrequencyPeak {
    fft_pass_number: u32,
    peak_magnitude: u16,
    corrected_peak_frequency_bin: u16,
}

pub struct Signature {
    number_samples: u32,
    bands: [Vec<FrequencyPeak>; 4],
}

impl Signature {
    pub fn sample_ms(&self) -> u32 {
        (self.number_samples as f32 / SAMPLE_RATE as f32 * 1000.0) as u32
    }

    pub fn peak_count(&self) -> usize {
        self.bands.iter().map(Vec::len).sum()
    }

    fn encode_to_binary(&self) -> Vec<u8> {
        let mut c = Cursor::new(vec![]);
        // Header: magic, crc (later), size (later), magic, void, sample-rate id (3 = 16 kHz) << 27,
        // void, sample count + rate * 0.24, fixed value.
        for v in [0xcafe2580u32, 0, 0, 0x94119c00, 0, 0, 0, 3 << 27, 0, 0] {
            c.write_u32::<LittleEndian>(v).unwrap();
        }
        c.write_u32::<LittleEndian>(self.number_samples + (SAMPLE_RATE as f32 * 0.24) as u32).unwrap();
        c.write_u32::<LittleEndian>((15 << 19) + 0x40000).unwrap();
        c.write_u32::<LittleEndian>(0x40000000).unwrap();
        c.write_u32::<LittleEndian>(0).unwrap(); // size, later

        for (band, peaks) in self.bands.iter().enumerate() {
            if peaks.is_empty() {
                continue;
            }
            let mut p = Cursor::new(vec![]);
            let mut pass = 0;
            for peak in peaks {
                if peak.fft_pass_number - pass >= 255 {
                    p.write_u8(0xff).unwrap();
                    p.write_u32::<LittleEndian>(peak.fft_pass_number).unwrap();
                    pass = peak.fft_pass_number;
                }
                p.write_u8((peak.fft_pass_number - pass) as u8).unwrap();
                p.write_u16::<LittleEndian>(peak.peak_magnitude).unwrap();
                p.write_u16::<LittleEndian>(peak.corrected_peak_frequency_bin).unwrap();
                pass = peak.fft_pass_number;
            }
            let buf = p.into_inner();
            c.write_u32::<LittleEndian>(0x60030040 + band as u32).unwrap();
            c.write_u32::<LittleEndian>(buf.len() as u32).unwrap();
            c.write_all(&buf).unwrap();
            c.write_all(&vec![0u8; (4 - buf.len() % 4) % 4]).unwrap();
        }

        let size = c.position() as u32;
        c.seek(SeekFrom::Start(8)).unwrap();
        c.write_u32::<LittleEndian>(size - 48).unwrap();
        c.seek(SeekFrom::Start(52)).unwrap();
        c.write_u32::<LittleEndian>(size - 48).unwrap();
        let crc = crc32fast::hash(&c.get_ref()[8..]);
        c.seek(SeekFrom::Start(4)).unwrap();
        c.write_u32::<LittleEndian>(crc).unwrap();
        c.into_inner()
    }

    pub fn encode_to_uri(&self) -> String {
        format!(
            "data:audio/vnd.shazam.sig;base64,{}",
            base64::prelude::BASE64_STANDARD.encode(self.encode_to_binary())
        )
    }
}

struct Generator {
    ring: [i16; 2048],
    ring_index: usize,
    reordered: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    fft_outputs: Vec<[f32; 1025]>,
    fft_index: u8,
    spread: Vec<[f32; 1025]>,
    spread_index: u8,
    spread_done: u32,
    fft: std::sync::Arc<dyn realfft::RealToComplex<f32>>,
    bands: [Vec<FrequencyPeak>; 4],
}

/// Build a signature from mono 16 kHz samples in [-1, 1].
pub fn from_samples(samples: &[f32]) -> Signature {
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(2048);
    let mut g = Generator {
        ring: [0; 2048],
        ring_index: 0,
        reordered: fft.make_input_vec(),
        spectrum: fft.make_output_vec(),
        fft_outputs: vec![[0.0; 1025]; 256],
        fft_index: 0,
        spread: vec![[0.0; 1025]; 256],
        spread_index: 0,
        spread_done: 0,
        fft,
        bands: Default::default(),
    };
    let s16: Vec<i16> = samples.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect();
    for chunk in s16.as_chunks::<128>().0 {
        g.do_fft(chunk);
        g.do_peak_spreading();
        g.spread_done += 1;
        if g.spread_done >= 46 {
            g.do_peak_recognition();
        }
    }
    Signature { number_samples: samples.len() as u32, bands: g.bands }
}

impl Generator {
    fn do_fft(&mut self, chunk: &[i16; 128]) {
        self.ring[self.ring_index..self.ring_index + 128].copy_from_slice(chunk);
        self.ring_index = (self.ring_index + 128) & 2047;
        for (i, m) in HANNING.iter().enumerate() {
            self.reordered[i] = self.ring[(i + self.ring_index) & 2047] as f32 * m;
        }
        self.fft.process(&mut self.reordered, &mut self.spectrum).unwrap();
        let out = &mut self.fft_outputs[self.fft_index as usize];
        for (r, c) in out.iter_mut().zip(self.spectrum.iter()) {
            *r = ((c.re * c.re + c.im * c.im) / (1 << 17) as f32).max(1e-10);
        }
        self.fft_index = self.fft_index.wrapping_add(1);
    }

    fn do_peak_spreading(&mut self) {
        let mut cur = self.fft_outputs[self.fft_index.wrapping_sub(1) as usize];
        for p in 0..=1022 {
            cur[p] = cur[p].max(cur[p + 1]).max(cur[p + 2]);
        }
        self.spread[self.spread_index as usize] = cur;
        for p in 0..=1024 {
            for former in [1u8, 3, 6] {
                let f = &mut self.spread[self.spread_index.wrapping_sub(former) as usize];
                f[p] = f[p].max(cur[p]);
            }
        }
        self.spread_index = self.spread_index.wrapping_add(1);
    }

    fn do_peak_recognition(&mut self) {
        let fft46 = &self.fft_outputs[self.fft_index.wrapping_sub(46) as usize];
        let fft49 = &self.spread[self.spread_index.wrapping_sub(49) as usize];
        let mag = |v: f32| v.ln().max(1.0 / 64.0) * 1477.3 + 6144.0;

        for bin in 10..=1014usize {
            if fft46[bin] < 1.0 / 64.0 || fft46[bin] < fft49[bin - 1] {
                continue;
            }
            let mut max_n = 0.0f32;
            for off in [-10i32, -7, -4, -3, 1, 2, 5, 8] {
                max_n = max_n.max(fft49[(bin as i32 + off) as usize]);
            }
            if fft46[bin] <= max_n {
                continue;
            }
            let mut max_t = max_n;
            for off in [-53i32, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249] {
                let other = &self.spread[((self.spread_index as i32 + off) & 255) as usize];
                max_t = max_t.max(other[bin - 1]);
            }
            if fft46[bin] <= max_t {
                continue;
            }

            let (m, before, after) = (mag(fft46[bin]), mag(fft46[bin - 1]), mag(fft46[bin + 1]));
            let var1 = m * 2.0 - before - after;
            let var2 = (after - before) * 32.0 / var1;
            let corrected = ((bin as i32 * 64) + var2 as i32) as u16;
            let hz = corrected as f32 * (16000.0 / 2.0 / 1024.0 / 64.0);
            let band = match hz as i32 {
                250..=519 => 0,
                520..=1449 => 1,
                1450..=3499 => 2,
                3500..=5500 => 3,
                _ => continue,
            };
            self.bands[band].push(FrequencyPeak {
                fft_pass_number: self.spread_done - 46,
                peak_magnitude: m as u16,
                corrected_peak_frequency_bin: corrected,
            });
        }
    }
}

/// Linear resample of interleaved audio to mono 16 kHz.
pub fn to_mono_16k(interleaved: &[f32], channels: usize, rate: u32) -> Vec<f32> {
    let mono: Vec<f32> = interleaved
        .chunks(channels.max(1))
        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
        .collect();
    resample(&mono, rate)
}

pub fn resample(mono: &[f32], rate: u32) -> Vec<f32> {
    if rate == SAMPLE_RATE || mono.is_empty() {
        return mono.to_vec();
    }
    let step = rate as f64 / SAMPLE_RATE as f64;
    let n = (mono.len() as f64 / step) as usize;
    (0..n)
        .map(|i| {
            let pos = i as f64 * step;
            let j = pos as usize;
            let frac = (pos - j as f64) as f32;
            let a = mono[j];
            let b = *mono.get(j + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hanning_matches_songrec_table_endpoints() {
        assert!((HANNING[0] - 0.0000023508).abs() < 1e-9);
        assert!((HANNING[1] - 0.0000094032).abs() < 1e-9);
        assert!((HANNING[2047] - HANNING[0]).abs() < 1e-9);
    }

    #[test]
    fn tone_produces_peaks_and_valid_header() {
        let tone: Vec<f32> = (0..SAMPLE_RATE * 6)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / SAMPLE_RATE as f32).sin() * 0.5)
            .collect();
        let sig = from_samples(&tone);
        assert!(sig.peak_count() > 0);
        assert_eq!(sig.sample_ms(), 6000);
        let bin = sig.encode_to_binary();
        assert_eq!(&bin[0..4], &0xcafe2580u32.to_le_bytes());
        assert_eq!(crc32fast::hash(&bin[8..]).to_le_bytes(), bin[4..8]);
        assert!(sig.encode_to_uri().starts_with("data:audio/vnd.shazam.sig;base64,"));
    }

    #[test]
    fn resample_halves_48k_to_16k_length() {
        assert_eq!(resample(&vec![0.0; 48_000], 48_000).len(), 16_000);
        assert_eq!(to_mono_16k(&vec![0.5; 32_000], 2, 16_000), vec![0.5; 16_000]);
    }
}
