"""Del 20 A: groove-mål på syntetiske signaler med kjent fasit. Kjøres av packages/ingest/test/groove.test.ts."""
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
from groove_analysis import SR, analyze_stems, beat_grid, swing_percent, vocal_map  # noqa: E402

rng = np.random.default_rng(1)


def click(n, freq, decay_ms):
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * freq * t) * np.exp(-t / (decay_ms / 1000))).astype(np.float32)


def hat():
    n = int(0.03 * SR)
    noise = rng.standard_normal(n).astype(np.float32)
    return noise * np.exp(-np.arange(n) / SR / 0.008).astype(np.float32)


def drums(bpm, swing_pct, seconds=40, start=0.5):
    x = np.zeros(int(seconds * SR), dtype=np.float32)
    beat = 60 / bpm
    s16 = beat / 4
    k = click(int(0.15 * SR), 55, 60)
    h = hat()
    t = start
    while t + beat < seconds - 0.2:
        i = int(t * SR)
        x[i : i + len(k)] += k
        for q in range(4):
            off = q * s16 + (swing_pct / 100 * s16 if q % 2 == 1 else 0)
            j = int((t + off) * SR)
            x[j : j + len(h)] += 0.4 * h
        t += beat
    return x


out = {}
for s in (0, 10, 20):
    out[f"swing{s}"] = swing_percent(drums(125, s), 125)
# Takt-rutenett: kjent tempo og første slag (0,5 s)
d = drums(124, 0, start=0.5)
bass = np.zeros_like(d)
g = beat_grid(d, bass, None, len(d) / SR)
out["gridBpm"] = g["bpm"]
out["firstBeatMs"] = g["firstDownbeatMs"]
# Vokalkart: tone 4–9 s og 15–22 s i vokalstammen
v = np.zeros(int(30 * SR), dtype=np.float32)
for a, b in ((4, 9), (15, 22)):
    t = np.arange(int((b - a) * SR)) / SR
    v[int(a * SR) : int(b * SR)] = 0.3 * np.sin(2 * np.pi * 220 * t)
mix = v + 0.05 * rng.standard_normal(len(v)).astype(np.float32)
out["vocals"] = vocal_map(v, mix)
# Hele analysen kjører på kort signal uten å feile
full = analyze_stems({"drums": d[: 20 * SR], "bass": bass[: 20 * SR], "vocals": v[: 20 * SR], "other": np.zeros(20 * SR, dtype=np.float32)}, d[: 20 * SR] + v[: 20 * SR], 124.0)
out["fullKeys"] = sorted(full.keys())
print(json.dumps(out))
