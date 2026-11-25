pub mod client;
pub mod signature;

pub use client::{RecognizeError, Song, now_ms, recognize, recognize_signature};
