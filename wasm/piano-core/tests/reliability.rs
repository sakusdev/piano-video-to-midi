use piano_video_core::{
    analyze_audio_onsets, analyze_color_columns, measure_key_glow, wasm_engine_version,
};

#[test]
fn public_abi_version_matches_package() {
    assert_eq!(wasm_engine_version(), env!("CARGO_PKG_VERSION"));
}

#[test]
fn invalid_or_truncated_inputs_fail_closed() {
    assert!(analyze_audio_onsets(&[], 44_100, 2_048, 512).is_empty());
    assert!(analyze_audio_onsets(&[0.0; 4_096], 0, 2_048, 512).is_empty());
    assert!(analyze_color_columns(&[0; 15], 2, 2, 0.0, 1.0, 10.0, 8.0, 200.0, 100.0).is_empty());
    assert!(measure_key_glow(&[0; 15], 2, 2, &[60.0, 0.0, 0.0, 1.0, 1.0]).is_empty());
}

#[test]
fn audio_analysis_is_deterministic_and_finite() {
    let sample_rate = 44_100u32;
    let mut samples = vec![0.0f32; sample_rate as usize * 2];
    for center in [11_025usize, 33_075usize, 66_150usize] {
        for offset in 0..768usize {
            let phase = offset as f32 / sample_rate as f32 * 523.25 * std::f32::consts::TAU;
            samples[center + offset] = phase.sin() * (1.0 - offset as f32 / 768.0);
        }
    }

    let first = analyze_audio_onsets(&samples, sample_rate, 2_048, 512);
    let second = analyze_audio_onsets(&samples, sample_rate, 2_048, 512);
    assert_eq!(first.as_ref(), second.as_ref());
    assert_eq!(first.len() % 2, 0);
    assert!(first.iter().all(|value| value.is_finite()));
    assert!(first
        .chunks_exact(2)
        .all(|pair| pair[0] >= 0.0 && (0.0..=1.0).contains(&pair[1])));
}

#[test]
fn vision_outputs_have_stable_tuple_shapes() {
    let width = 16usize;
    let height = 8usize;
    let mut pixels = vec![0u8; width * height * 4];
    for y in 0..height {
        for x in 4..12 {
            let offset = (y * width + x) * 4;
            pixels[offset] = 40;
            pixels[offset + 1] = 180;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = 255;
        }
    }

    let columns = analyze_color_columns(
        &pixels, width, height, 0.0, 8.0, 10.0, 8.0, 198.0, 198.0,
    );
    assert_eq!(columns.len() % 4, 0);
    assert!(columns.iter().all(|value| value.is_finite()));

    let rects = [60.0, 0.0, 0.0, 8.0, 8.0, 61.0, 8.0, 0.0, 8.0, 8.0];
    let glow = measure_key_glow(&pixels, width, height, &rects);
    assert_eq!(glow.len(), 4);
    assert!(glow.iter().all(|value| value.is_finite()));
    assert_eq!(glow[0], 60.0);
    assert_eq!(glow[2], 61.0);
}
