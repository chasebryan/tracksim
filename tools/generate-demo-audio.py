#!/usr/bin/env python3
"""Render a deterministic stereo soundtrack for a tracksim mission video.

The scenario's simulation time is mapped linearly onto the requested video
duration. No external packages or sound assets are needed.

Example:
    python3 tools/generate-demo-audio.py \
        --duration 240 \
        --scenario packages/sim/scenarios/full-mission.json \
        --output out/tracksim-demo.wav
"""

from __future__ import annotations

import argparse
from array import array
import json
import math
from pathlib import Path
import random
import sys
import wave


TAU = 2.0 * math.pi
SAMPLE_RATE = 32_000
BLOCK_FRAMES = 8192
SEED = 0x54524143


class Voice:
    __slots__ = ("start", "samples", "left", "right")

    def __init__(self, start: int, samples: array, gain: float, pan: float):
        self.start = start
        self.samples = samples
        # Equal-power panning keeps cues audible at the sides of the stereo image.
        self.left = gain * math.sqrt((1.0 - pan) / 2.0)
        self.right = gain * math.sqrt((1.0 + pan) / 2.0)


def chirp(rate: int, seconds: float, start_hz: float, end_hz: float,
          decay: float = 4.0, wobble_hz: float = 0.0) -> array:
    """A soft-edged swept sine with a faint second harmonic."""
    count = max(1, round(seconds * rate))
    data = array("f")
    append = data.append
    sin = math.sin
    exp = math.exp
    for i in range(count):
        t = i / rate
        progress = i / count
        frequency_phase = start_hz * t + 0.5 * (end_hz - start_hz) * t * progress
        phase = TAU * frequency_phase
        if wobble_hz:
            phase += 0.35 * sin(TAU * wobble_hz * t)
        attack = min(1.0, t / 0.012)
        release = min(1.0, (seconds - t) / 0.025)
        envelope = attack * max(0.0, release) * exp(-decay * progress)
        append(envelope * (0.88 * sin(phase) + 0.12 * sin(2.0 * phase)))
    return data


def static_burst(rate: int, seconds: float, seed: int) -> array:
    """Filtered noise that resembles a brief radio interference burst."""
    count = max(1, round(seconds * rate))
    data = array("f")
    append = data.append
    rng = random.Random(seed)
    low = 0.0
    for i in range(count):
        t = i / rate
        progress = i / count
        noise = 2.0 * rng.random() - 1.0
        low += 0.12 * (noise - low)
        filtered = noise - low
        fade = min(1.0, t / 0.04, (seconds - t) / 0.15)
        flutter = 0.65 + 0.35 * math.sin(TAU * 13.0 * t) ** 2
        append(filtered * max(0.0, fade) * flutter * (1.0 - 0.55 * progress))
    return data


def build_voices(scenario: dict, duration: float, rate: int) -> list[Voice]:
    scale = duration / float(scenario["durationS"])
    voices: list[Voice] = []

    def add(sim_time: float, samples: array, gain: float, pan: float = 0.0) -> None:
        start = round(sim_time * scale * rate)
        if start < round(duration * rate):
            voices.append(Voice(start, samples, gain, max(-1.0, min(1.0, pan))))

    # A quiet, moving radar return every 2.2 video seconds.
    ping = chirp(rate, 0.43, 1380.0, 930.0, decay=5.0)
    echo = chirp(rate, 0.28, 940.0, 710.0, decay=6.0)
    count = math.ceil(duration / 2.2)
    for i in range(count):
        video_time = 0.8 + i * 2.2
        pan = 0.68 * math.sin(i * 0.47)
        sim_time = video_time / scale
        add(sim_time, ping, 0.075, pan)
        if i % 4 == 0:
            add((video_time + 0.22) / scale, echo, 0.025, -pan)

    # Cue types are taken from the scenario, so the sounds follow its actual
    # event timestamps even if the scenario is edited or rendered at a new rate.
    for event_index, event in enumerate(scenario.get("events", [])):
        time = float(event["t"])
        kind = event["type"]
        if kind == "intel":
            add(time, chirp(rate, 0.8, 810, 1030, 3.0), 0.11, -0.25)
            add(time + 0.30 / scale, chirp(rate, 0.7, 1220, 1220, 4.0), 0.055, 0.25)
        elif kind == "sensor.noise":
            add(time, chirp(rate, 1.2, 950, 410, 2.1, 18), 0.16, -0.50)
            add(time + 0.6 / scale, static_burst(rate, 0.8, SEED + event_index), 0.07, -0.4)
        elif kind == "sensor.enable":
            if event.get("enabled") is False:
                for n in range(2):
                    add(time + n * 0.37 / scale, chirp(rate, 0.34, 720, 390, 2.8), 0.15, -0.45)
            else:
                add(time, chirp(rate, 0.85, 480, 1050, 2.6), 0.13, 0.45)
        elif kind == "sensor.bias":
            for n in range(3):
                add(time + n * 0.32 / scale,
                    chirp(rate, 0.47, 650 + 70 * n, 580 + 50 * n, 2.2, 23),
                    0.14, (-0.55 if n % 2 == 0 else 0.55))
        elif kind == "contacts.spawn":
            for n in range(min(8, len(event.get("contacts", [])))):
                add(time + n * 0.19 / scale,
                    chirp(rate, 0.52, 680 + n * 75, 1160 + n * 60, 3.3),
                    0.12, -0.7 + n * 0.28)
        elif kind == "radar.clutter":
            for n in range(3):
                add(time + n * 0.62 / scale,
                    static_burst(rate, 0.65, SEED + event_index * 17 + n),
                    0.095, (-0.5 if n % 2 else 0.5))
        elif kind == "radar.pd":
            add(time, chirp(rate, 1.3, 190, 145, 2.5), 0.085)
        elif kind == "platform.turn":
            add(time, chirp(rate, 4.0, 170, 460, 0.7, 2.5), 0.12, 0.30)
        elif kind == "platform.accel":
            add(time, chirp(rate, 2.2, 110, 260, 1.4), 0.11, -0.25)
        elif kind == "contact.despawn":
            add(time, chirp(rate, 0.62, 860, 350, 3.5), 0.085, 0.35)

    # The recovery phase gets a soft, resolved three-note signal.
    for phase in scenario.get("phases", []):
        if "recover" in phase["name"].lower():
            time = float(phase["t"])
            for n, note in enumerate((440.0, 554.37, 659.25)):
                add(time + n * 0.18 / scale,
                    chirp(rate, 2.3, note, note, 2.4), 0.08, (n - 1) * 0.42)

    voices.sort(key=lambda voice: voice.start)
    return voices


def generate(scenario_path: Path, output: Path, duration: float) -> tuple[int, float]:
    with scenario_path.open("r", encoding="utf-8") as source:
        scenario = json.load(source)
    scenario_duration = float(scenario["durationS"])
    if not math.isfinite(scenario_duration) or scenario_duration <= 0:
        raise ValueError("scenario durationS must be positive and finite")
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be positive and finite")

    rate = SAMPLE_RATE
    total_frames = round(duration * rate)
    voices = build_voices(scenario, duration, rate)
    phase_frames = [
        (round(float(phase["t"]) * duration / scenario_duration * rate),
         phase["name"].lower())
        for phase in scenario.get("phases", [])
    ]
    phase_frames.sort()
    phase_index = 0
    target_energy = 1.0
    energy = 1.0
    rng = random.Random(SEED)
    sin = math.sin
    maximum = 0.0

    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        for block_start in range(0, total_frames, BLOCK_FRAMES):
            block_end = min(total_frames, block_start + BLOCK_FRAMES)
            size = block_end - block_start
            left = array("f", [0.0]) * size
            right = array("f", [0.0]) * size

            for j in range(size):
                frame = block_start + j
                while phase_index < len(phase_frames) and frame >= phase_frames[phase_index][0]:
                    name = phase_frames[phase_index][1]
                    if "degradation" in name:
                        target_energy = 1.18
                    elif "decoy" in name:
                        target_energy = 1.32
                    elif "manoeuvre" in name or "maneuver" in name:
                        target_energy = 1.20
                    elif "recover" in name:
                        target_energy = 0.82
                    else:
                        target_energy = 1.0
                    phase_index += 1
                energy += (target_energy - energy) * 0.00018
                t = frame / rate
                breath = 0.78 + 0.22 * sin(TAU * 0.055 * t)
                drone = (0.026 * sin(TAU * 55.0 * t)
                         + 0.013 * sin(TAU * 82.41 * t)
                         + 0.008 * sin(TAU * 220.0 * t + 0.3 * sin(TAU * 0.07 * t)))
                hiss = 0.0014 * (2.0 * rng.random() - 1.0)
                bed = energy * breath * drone + hiss
                left[j] = bed
                right[j] = 0.94 * bed + 0.004 * energy * sin(TAU * 55.22 * t)

            for voice in voices:
                overlap_start = max(block_start, voice.start)
                overlap_end = min(block_end, voice.start + len(voice.samples))
                if overlap_start >= overlap_end:
                    continue
                source = voice.samples
                for frame in range(overlap_start, overlap_end):
                    value = source[frame - voice.start]
                    index = frame - block_start
                    left[index] += value * voice.left
                    right[index] += value * voice.right

            pcm = array("h")
            append = pcm.append
            for j in range(size):
                l = left[j]
                r = right[j]
                maximum = max(maximum, abs(l), abs(r))
                if abs(l) >= 1.0 or abs(r) >= 1.0:
                    raise ValueError("soundtrack exceeded full scale; reduce cue gains")
                append(round(l * 32767))
                append(round(r * 32767))
            if sys.byteorder != "little":
                pcm.byteswap()
            audio.writeframesraw(pcm.tobytes())

    return len(voices), maximum


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=240.0,
                        help="output length in seconds (default: 240)")
    parser.add_argument("--scenario", type=Path,
                        default=repo_root / "packages/sim/scenarios/full-mission.json")
    parser.add_argument("--output", type=Path, default=repo_root / "out/tracksim-demo.wav")
    args = parser.parse_args()
    cue_count, peak = generate(args.scenario, args.output, args.duration)
    print(f"Wrote {args.output} ({args.duration:g} s, stereo {SAMPLE_RATE} Hz PCM WAV; "
          f"{cue_count} cues; peak {20 * math.log10(max(peak, 1e-12)):.1f} dBFS)")


if __name__ == "__main__":
    main()
