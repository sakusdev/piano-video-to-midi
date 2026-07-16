use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

const MIN_FREQUENCY_HZ: f64 = 27.5;
const MAX_FREQUENCY_HZ: f64 = 5_000.0;

fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.max(minimum).min(maximum)
}

fn hue_distance(left: f64, right: f64) -> f64 {
    let distance = (left - right).abs() % 360.0;
    if distance > 180.0 {
        360.0 - distance
    } else {
        distance
    }
}

fn rgb_to_hsv(red: u8, green: u8, blue: u8) -> (f64, f64, f64) {
    let red = red as f64 / 255.0;
    let green = green as f64 / 255.0;
    let blue = blue as f64 / 255.0;
    let maximum = red.max(green).max(blue);
    let minimum = red.min(green).min(blue);
    let delta = maximum - minimum;
    let mut hue = 0.0;

    if delta != 0.0 {
        if maximum == red {
            hue = ((green - blue) / delta) % 6.0;
        } else if maximum == green {
            hue = (blue - red) / delta + 2.0;
        } else {
            hue = (red - green) / delta + 4.0;
        }
        hue *= 60.0;
        if hue < 0.0 {
            hue += 360.0;
        }
    }

    let saturation = if maximum == 0.0 { 0.0 } else { delta / maximum };
    (hue, saturation, maximum)
}

fn fft(real: &mut [f64], imaginary: &mut [f64]) {
    let size = real.len();
    let mut swap_index = 0usize;
    for index in 1..size {
        let mut bit = size >> 1;
        while swap_index & bit != 0 {
            swap_index ^= bit;
            bit >>= 1;
        }
        swap_index ^= bit;
        if index < swap_index {
            real.swap(index, swap_index);
            imaginary.swap(index, swap_index);
        }
    }

    let mut length = 2usize;
    while length <= size {
        let angle = -2.0 * std::f64::consts::PI / length as f64;
        let step_real = angle.cos();
        let step_imaginary = angle.sin();
        let mut start = 0usize;
        while start < size {
            let mut unit_real = 1.0;
            let mut unit_imaginary = 0.0;
            for offset in 0..length / 2 {
                let even = start + offset;
                let odd = even + length / 2;
                let odd_real = real[odd] * unit_real - imaginary[odd] * unit_imaginary;
                let odd_imaginary = real[odd] * unit_imaginary + imaginary[odd] * unit_real;
                real[odd] = real[even] - odd_real;
                imaginary[odd] = imaginary[even] - odd_imaginary;
                real[even] += odd_real;
                imaginary[even] += odd_imaginary;
                let next_real = unit_real * step_real - unit_imaginary * step_imaginary;
                unit_imaginary = unit_real * step_imaginary + unit_imaginary * step_real;
                unit_real = next_real;
            }
            start += length;
        }
        length <<= 1;
    }
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}

fn find_adaptive_onsets(envelope: &[f64], hop_ms: f64) -> Vec<f64> {
    if envelope.len() < 5 {
        return Vec::new();
    }

    let global_median = median(envelope);
    let global_deviations: Vec<f64> = envelope
        .iter()
        .map(|value| (value - global_median).abs())
        .collect();
    let global_mad = median(&global_deviations).max(1e-6);
    let mut packed = Vec::<f64>::new();
    let mut last_ms = f64::NEG_INFINITY;
    let radius = 14usize;

    for index in 2..envelope.len() - 2 {
        let value = envelope[index];
        if !(value >= envelope[index - 1] && value > envelope[index + 1]) {
            continue;
        }

        let local_start = index.saturating_sub(radius);
        let local_end = (index + radius + 1).min(envelope.len());
        let local_values = &envelope[local_start..local_end];
        let local_median = median(local_values);
        let local_deviations: Vec<f64> = local_values
            .iter()
            .map(|item| (item - local_median).abs())
            .collect();
        let local_mad = median(&local_deviations).max(global_mad);
        let threshold = local_median + (local_mad * 2.7).max(global_mad * 0.72);
        if value < threshold || value < global_median + global_mad * 0.58 {
            continue;
        }

        let ms = index as f64 * hop_ms;
        let strength = clamp(
            (value - local_median) / (local_mad * 6.0).max(1e-6),
            0.0,
            1.0,
        );

        if ms - last_ms < 34.0 {
            if packed.len() >= 2 {
                let previous_strength_index = packed.len() - 1;
                if strength > packed[previous_strength_index] {
                    let previous_ms_index = packed.len() - 2;
                    packed[previous_ms_index] = ms;
                    packed[previous_strength_index] = strength;
                    last_ms = ms;
                }
            }
            continue;
        }

        packed.push(ms);
        packed.push(strength);
        last_ms = ms;
    }

    packed
}

fn analyze_audio(
    samples: &[f32],
    sample_rate: u32,
    requested_fft_size: usize,
    requested_hop_size: usize,
) -> Vec<f64> {
    if sample_rate == 0 || samples.is_empty() {
        return Vec::new();
    }

    let fft_size = if requested_fft_size.is_power_of_two() {
        requested_fft_size.clamp(256, 8_192)
    } else {
        2_048
    };
    let hop_size = requested_hop_size.clamp(64, fft_size);
    if samples.len() <= fft_size {
        return Vec::new();
    }

    let frame_count = (samples.len() - fft_size) / hop_size;
    if frame_count == 0 {
        return Vec::new();
    }

    let window: Vec<f64> = (0..fft_size)
        .map(|index| {
            0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / (fft_size - 1) as f64).cos()
        })
        .collect();
    let mut real = vec![0.0f64; fft_size];
    let mut imaginary = vec![0.0f64; fft_size];
    let mut previous_magnitude = vec![0.0f64; fft_size / 2];
    let mut envelope = vec![0.0f64; frame_count];
    let nyquist_bin = fft_size / 2 - 1;
    let low_bin = ((MIN_FREQUENCY_HZ * fft_size as f64 / sample_rate as f64).floor() as usize)
        .clamp(1, nyquist_bin.saturating_sub(1).max(1));
    let high_bin = ((MAX_FREQUENCY_HZ * fft_size as f64 / sample_rate as f64).ceil() as usize)
        .clamp(low_bin + 1, nyquist_bin);
    let mut previous_rms = 0.0f64;

    for (frame, frame_envelope) in envelope.iter_mut().enumerate() {
        let start = frame * hop_size;
        let mut energy = 0.0f64;
        for sample_index in 0..fft_size {
            let value = samples[start + sample_index] as f64;
            energy += value * value;
            real[sample_index] = value * window[sample_index];
            imaginary[sample_index] = 0.0;
        }

        fft(&mut real, &mut imaginary);
        let mut flux = 0.0f64;
        let mut spectral_energy = 0.0f64;
        for bin in low_bin..=high_bin {
            let magnitude = (real[bin].hypot(imaginary[bin])).ln_1p();
            flux += (magnitude - previous_magnitude[bin]).max(0.0);
            spectral_energy += magnitude;
            previous_magnitude[bin] = magnitude;
        }

        let rms = (energy / fft_size as f64).sqrt();
        let rms_rise = (rms - previous_rms).max(0.0);
        previous_rms = previous_rms * 0.7 + rms * 0.3;
        let bin_count = (high_bin - low_bin + 1) as f64;
        *frame_envelope = flux / bin_count * 1.55
            + rms_rise * 3.2
            + rms * 0.22
            + spectral_energy / bin_count * 0.01;
    }

    find_adaptive_onsets(&envelope, hop_size as f64 / sample_rate as f64 * 1_000.0)
}

#[wasm_bindgen]
pub fn analyze_audio_onsets(
    samples: &[f32],
    sample_rate: u32,
    fft_size: usize,
    hop_size: usize,
) -> Box<[f64]> {
    analyze_audio(samples, sample_rate, fft_size, hop_size).into_boxed_slice()
}

// This flat scalar ABI is intentionally stable for the JavaScript/WASM boundary.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn analyze_color_columns(
    pixels: &[u8],
    width: usize,
    height: usize,
    absolute_x: f64,
    split_x: f64,
    threshold: f64,
    color_tolerance: f64,
    left_hue: f64,
    right_hue: f64,
) -> Box<[f64]> {
    if width == 0 || height == 0 || pixels.len() < width.saturating_mul(height).saturating_mul(4) {
        return Vec::new().into_boxed_slice();
    }

    let minimum_saturation = 0.15 + color_tolerance * 0.006;
    let minimum_value = 0.22 + color_tolerance * 0.002;
    let hue_window = (34.0 - color_tolerance * 0.55).max(7.0);
    let minimum_ratio = clamp(threshold / 115.0, 0.025, 0.7);
    let mut packed = Vec::<f64>::new();

    for local_x in 0..width {
        let x = absolute_x + local_x as f64;
        let target_hue = if x < split_x { left_hue } else { right_hue };
        let mut hit_count = 0usize;
        let mut strength = 0.0f64;
        let mut dark_count = 0usize;

        for local_y in 0..height {
            let index = (local_y * width + local_x) * 4;
            let red = pixels[index];
            let green = pixels[index + 1];
            let blue = pixels[index + 2];
            let (hue, saturation, value) = rgb_to_hsv(red, green, blue);
            if saturation < minimum_saturation
                || value < minimum_value
                || hue_distance(hue, target_hue) > hue_window
            {
                continue;
            }

            hit_count += 1;
            let luma = 0.2126 * red as f64 + 0.7152 * green as f64 + 0.0722 * blue as f64;
            strength += saturation * 86.0 + value * 28.0 + (120.0 - luma).max(0.0) * 0.08;
            if luma < 118.0 || value < 0.46 {
                dark_count += 1;
            }
        }

        let score = hit_count as f64 / height as f64;
        if score >= minimum_ratio {
            packed.push(x);
            packed.push(score);
            packed.push(strength / hit_count.max(1) as f64);
            packed.push(dark_count as f64 / hit_count.max(1) as f64);
        }
    }

    packed.into_boxed_slice()
}

#[wasm_bindgen]
pub fn measure_key_glow(
    pixels: &[u8],
    width: usize,
    height: usize,
    key_rects: &[f64],
) -> Box<[f64]> {
    if width == 0 || height == 0 || pixels.len() < width.saturating_mul(height).saturating_mul(4) {
        return Vec::new().into_boxed_slice();
    }

    let mut packed = Vec::<f64>::with_capacity(key_rects.len() / 5 * 2);
    for key in key_rects.chunks_exact(5) {
        let midi = key[0];
        let x0 = clamp(key[1].floor(), 0.0, (width - 1) as f64) as usize;
        let y0 = clamp(key[2].floor(), 0.0, (height - 1) as f64) as usize;
        let x1 = clamp((key[1] + key[3]).ceil(), (x0 + 1) as f64, width as f64) as usize;
        let y1 = clamp((key[2] + key[4]).ceil(), (y0 + 1) as f64, height as f64) as usize;
        let mut sum = 0.0f64;
        let mut hot = 0usize;
        let mut count = 0usize;

        for y in (y0..y1).step_by(2) {
            for x in (x0..x1).step_by(2) {
                let index = (y * width + x) * 4;
                let luma = 0.2126 * pixels[index] as f64
                    + 0.7152 * pixels[index + 1] as f64
                    + 0.0722 * pixels[index + 2] as f64;
                sum += luma;
                if luma > 148.0 {
                    hot += 1;
                }
                count += 1;
            }
        }

        let count = count.max(1) as f64;
        packed.push(midi);
        packed.push(sum / count + hot as f64 / count * 72.0);
    }

    packed.into_boxed_slice()
}

#[wasm_bindgen]
pub fn wasm_engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_keeps_impulse_energy_flat() {
        let mut real = vec![0.0; 8];
        let mut imaginary = vec![0.0; 8];
        real[0] = 1.0;
        fft(&mut real, &mut imaginary);
        for value in real {
            assert!((value - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn analyzer_returns_finite_sorted_pairs() {
        let sample_rate = 44_100u32;
        let mut samples = vec![0.0f32; sample_rate as usize];
        for center in [8_820usize, 22_050usize, 35_280usize] {
            for offset in 0..512usize {
                let phase = offset as f32 / 44_100.0 * 440.0 * std::f32::consts::TAU;
                samples[center + offset] = phase.sin() * (1.0 - offset as f32 / 512.0);
            }
        }
        let packed = analyze_audio(&samples, sample_rate, 2_048, 512);
        assert_eq!(packed.len() % 2, 0);
        assert!(packed.iter().all(|value| value.is_finite()));
        let times: Vec<f64> = packed.chunks_exact(2).map(|pair| pair[0]).collect();
        assert!(times.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn color_columns_detect_matching_hue() {
        let width = 8usize;
        let height = 4usize;
        let mut pixels = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 2..6 {
                let index = (y * width + x) * 4;
                pixels[index] = 80;
                pixels[index + 1] = 180;
                pixels[index + 2] = 255;
                pixels[index + 3] = 255;
            }
        }
        let (target_hue, _, _) = rgb_to_hsv(80, 180, 255);
        let packed = analyze_color_columns(
            &pixels, width, height, 0.0, 4.0, 10.0, 8.0, target_hue, target_hue,
        );
        assert_eq!(packed.len(), 16);
        assert!(packed.chunks_exact(4).all(|column| column[1] > 0.9));
    }

    #[test]
    fn glow_measurement_returns_one_score_per_key() {
        let width = 8usize;
        let height = 8usize;
        let pixels = vec![255u8; width * height * 4];
        let keys = [60.0, 0.0, 0.0, 4.0, 8.0, 61.0, 4.0, 0.0, 4.0, 8.0];
        let packed = measure_key_glow(&pixels, width, height, &keys);
        assert_eq!(packed.len(), 4);
        assert!(packed[1] > 255.0);
        assert!(packed[3] > 255.0);
    }
}
