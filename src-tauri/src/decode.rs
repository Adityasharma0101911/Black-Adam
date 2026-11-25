//! Decode an audio/video file to mono 16 kHz for "identify from file".

use crate::shazam::signature::{SAMPLE_RATE, resample};
use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};

/// Returns up to 12 s of mono 16 kHz audio taken from the middle of the file.
pub fn decode_middle(path: &str) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Can't open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|_| "Unsupported file format".to_string())?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .filter(|t| t.codec_params.sample_rate.is_some())
        .or_else(|| format.tracks().iter().find(|t| t.codec_params.sample_rate.is_some()))
        .ok_or("No audio track in this file")?
        .clone();
    let rate = track.codec_params.sample_rate.unwrap();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| "Unsupported audio codec".to_string())?;

    let mut mono = Vec::new();
    // shortcut: decodes the whole file into memory, fine for songs; long mixes use more RAM.
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track.id {
            continue;
        }
        let Ok(decoded) = decoder.decode(&packet) else { continue };
        let ch = decoded.spec().channels.count().max(1);
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        buf.copy_interleaved_ref(decoded);
        mono.extend(buf.samples().chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
    }
    if mono.is_empty() {
        return Err("Couldn't decode any audio from this file".into());
    }
    let audio = resample(&mono, rate);
    let want = (12 * SAMPLE_RATE) as usize;
    if audio.len() <= want {
        return Ok(audio);
    }
    let start = audio.len() / 2 - want / 2;
    Ok(audio[start..start + want].to_vec())
}
