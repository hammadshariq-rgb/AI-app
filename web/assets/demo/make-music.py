"""
The bed under the demo recordings.

Written as a small synth rather than a stack of ffmpeg filters, because the
first attempt was one static chord and sounded like a held drone. This has a
progression, a pulse and a melody line, which is what makes something sound
composed rather than merely generated.

Every sample here is computed from oscillators, so there is nothing in it that
anyone can claim - which matters when the result is going on an advert.

Am - F - C - G at 92bpm, eight bars, built from four layers:
  pad   warm, slow to arrive, holds the chord
  bass  the root, once a bar, with a long tail
  arp   eighth notes through the chord, panned wide, the thing you hum
  air   a breath of filtered noise that swells across each bar
"""
import math
import struct
import wave

import numpy as np

SR = 44100
BPM = 92.0
BEAT = 60.0 / BPM
BAR = BEAT * 4

# A minor, which is where most things that sound hopeful but not sugary live.
NOTE = {
    'A2': 110.00, 'C3': 130.81, 'E3': 164.81, 'F2': 87.31, 'G2': 98.00,
    'A3': 220.00, 'C4': 261.63, 'E4': 329.63, 'F3': 174.61, 'G3': 196.00,
    'B3': 246.94, 'D4': 293.66, 'A4': 440.00, 'C5': 523.25, 'E5': 659.26,
    'G4': 392.00, 'F4': 349.23, 'D5': 587.33,
}

PROGRESSION = [
    ('A2', ['A3', 'C4', 'E4'], ['A4', 'C5', 'E5', 'C5']),
    ('F2', ['F3', 'A3', 'C4'], ['F4', 'A4', 'C5', 'A4']),
    ('C3', ['C4', 'E4', 'G4'], ['C5', 'E5', 'G4', 'E5']),
    ('G2', ['G3', 'B3', 'D4'], ['D5', 'B3', 'G4', 'D5']),
]
BARS = 24          # six times round, about a minute, longest clip is 56s


def env(n, attack, decay, sustain=0.0, release=0.0):
    """A straightforward ADSR, in seconds, over n samples."""
    a, d, r = int(attack * SR), int(decay * SR), int(release * SR)
    a, d, r = min(a, n), min(d, max(0, n - 1)), min(r, n)
    out = np.zeros(n)
    if a:
        out[:a] = np.linspace(0.0, 1.0, a)
    body = n - a - r
    if body > 0:
        if d and d < body:
            out[a:a + d] = np.linspace(1.0, sustain, d)
            out[a + d:a + body] = sustain
        else:
            out[a:a + body] = np.linspace(1.0, sustain, body)
    if r:
        start = out[n - r - 1] if n - r - 1 >= 0 else sustain
        out[n - r:] = np.linspace(start, 0.0, r)
    return out


def tone(freq, dur, harmonics=(1.0,), detune=0.0):
    """Additive oscillator. Detune in cents, applied as a second voice."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for i, amp in enumerate(harmonics, start=1):
        if amp == 0:
            continue
        out += amp * np.sin(2 * math.pi * freq * i * t)
        if detune:
            f2 = freq * (2 ** (detune / 1200.0))
            out += amp * 0.6 * np.sin(2 * math.pi * f2 * i * t)
    return out / max(1e-9, np.max(np.abs(out)))


def place(buf, sig, at):
    i = int(at * SR)
    n = min(len(sig), len(buf) - i)
    if n > 0:
        buf[i:i + n] += sig[:n]


total = BARS * BAR + 3.0
N = int(total * SR)
pad = np.zeros(N)
bass = np.zeros(N)
arp_l = np.zeros(N)
arp_r = np.zeros(N)
air = np.zeros(N)

for bar in range(BARS):
    root, chord, line = PROGRESSION[bar % len(PROGRESSION)]
    t0 = bar * BAR

    # Pad: slow in, holds the bar, overlaps the next so it never gaps.
    for note in chord:
        d = BAR * 1.25
        sig = tone(NOTE[note], d, harmonics=(1.0, 0.45, 0.22, 0.10), detune=7.0)
        sig *= env(len(sig), attack=0.9, decay=0.6, sustain=0.72, release=BAR * 0.5)
        place(pad, sig * 0.30, t0)

    # Bass arrives at bar 3 and the arp at bar 5, so it opens up instead of
    # starting at full strength and staying there.
    # Bass: once a bar, with a tail under the next chord.
    if bar >= 2:
        d = BAR * 0.95
        sig = tone(NOTE[root], d, harmonics=(1.0, 0.30, 0.08))
        sig *= env(len(sig), attack=0.012, decay=0.5, sustain=0.42, release=0.7)
        place(bass, sig * 0.52, t0)

    # Arp: eighth notes, alternating sides so it opens up in headphones.
    for step in range(8 if bar >= 4 else 0):
        note = line[step % len(line)]
        at = t0 + step * (BEAT / 2)
        d = BEAT * 0.62
        sig = tone(NOTE[note], d, harmonics=(1.0, 0.0, 0.18, 0.0, 0.06))
        sig *= env(len(sig), attack=0.004, decay=0.26, sustain=0.0)
        # Quieter on the offbeats, so it breathes instead of machine-gunning.
        amp = 0.17 if step % 2 == 0 else 0.10
        if step % 2 == 0:
            place(arp_l, sig * amp, at)
            place(arp_r, sig * amp * 0.55, at)
        else:
            place(arp_r, sig * amp, at)
            place(arp_l, sig * amp * 0.55, at)

    # Air: a filtered noise swell, one per bar, very low in the mix.
    n = int(BAR * SR)
    noise = np.random.default_rng(bar).normal(0, 1, n)
    k = 220
    noise = np.convolve(noise, np.ones(k) / k, mode='same')   # crude lowpass
    noise *= env(n, attack=BAR * 0.6, decay=0.1, sustain=1.0, release=BAR * 0.35)
    place(air, noise * 0.035, t0)


def reverb(x, taps=((0.045, 0.30), (0.071, 0.22), (0.113, 0.15), (0.167, 0.09))):
    out = x.copy()
    for delay, gain in taps:
        d = int(delay * SR)
        out[d:] += x[:-d] * gain
    return out


left = reverb(pad * 0.9 + bass + arp_l + air)
right = reverb(pad * 0.9 + bass + arp_r + air)

# Gentle pump on the beat, so it moves without a drum kit.
t = np.arange(N) / SR
pump = 0.90 + 0.10 * np.sin(2 * math.pi * (1.0 / BEAT) * t - math.pi / 2)
left *= pump
right *= pump

# Fade in and out, then soft-limit and normalise to a comfortable bed level.
fi, fo = int(2.5 * SR), int(3.5 * SR)
for ch in (left, right):
    ch[:fi] *= np.linspace(0, 1, fi)
    ch[-fo:] *= np.linspace(1, 0, fo)

stereo = np.stack([left, right], axis=1)
stereo = np.tanh(stereo * 0.8)                       # soft knee, no hard clip
stereo /= max(1e-9, np.max(np.abs(stereo)))
stereo *= 0.62                                       # sits under a voice-over

pcm = (stereo * 32767).astype('<i2')
with wave.open('music-bed.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

print('wrote music-bed.wav  %.1fs  %.1f MB' % (total, pcm.nbytes / 1048576))
