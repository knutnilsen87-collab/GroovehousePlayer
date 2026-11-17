"""
Groovehouse Vault – del 20 A: analyse fra stemmer (Demucs htdemucs: trommer, bass, vokal, resten).

Lagrer bare utledede tall (ikke stemmene):
  - takt-rutenett: første downbeat og BPM takt for takt
  - groove fra trommene: swing, perkusjonstetthet, 4/4-kick, hat-lysstyrke
  - bass: sub-tung eller mellombass, lange eller korte toner, aktiv i intro/outro
  - vokalkart: tidsintervaller med vokal
  - ren intro/outro i takter (uten vokal, og uten bass)

Funksjonene under tar numpy-signaler (mono, float32) og kan testes uten Demucs og GPU.
Ingen sjangergjenkjenning: stil håndteres med Knuts egne tagger (del 20 D).
"""
from __future__ import annotations

import math

import numpy as np
from scipy import signal

SR = 22050


# ---------------------------------------------------------------- hjelpere

def band(x: np.ndarray, lo: float | None, hi: float | None, sr: int = SR) -> np.ndarray:
    """Båndpass (Butterworth, 4. orden, null fase)."""
    nyq = sr / 2
    if lo and hi:
        sos = signal.butter(4, [lo / nyq, min(hi / nyq, 0.99)], btype="band", output="sos")
    elif lo:
        sos = signal.butter(4, lo / nyq, btype="high", output="sos")
    else:
        sos = signal.butter(4, hi / nyq, btype="low", output="sos")
    return signal.sosfiltfilt(sos, x).astype(np.float32)


def envelope(x: np.ndarray, sr: int = SR, smooth_ms: float = 4.0) -> np.ndarray:
    """Amplitude-konvolutt (likerettet og glattet)."""
    if len(x) == 0:
        return np.zeros(0, dtype=np.float32)
    n = max(1, int(sr * smooth_ms / 1000))
    k = np.ones(n, dtype=np.float32) / n
    return np.convolve(np.abs(x), k, mode="same")


def onsets(x: np.ndarray, sr: int = SR, smooth_ms: float = 2.0, min_gap_ms: float = 50.0, rel: float = 0.25) -> np.ndarray:
    """
    Anslagstider (sekunder) fra stigningen i konvolutten. Tidspunktet er der konvolutten først når halve
    toppen i hvert anslag (presist til under 1 ms), ikke selve toppen.
    """
    env = envelope(x, sr, smooth_ms)
    if env.max() <= 1e-9:
        return np.zeros(0)
    d = np.diff(env, prepend=env[0])
    d[d < 0] = 0
    thr = rel * np.percentile(d[d > 0], 99) if np.any(d > 0) else 0
    peaks, _ = signal.find_peaks(d, height=thr, distance=max(1, int(sr * min_gap_ms / 1000)))
    out = []
    for p in peaks:
        # Gå bakover til konvolutten var under halve nivået ved toppen av anslaget
        top_end = min(len(env), p + int(sr * 0.02))
        top = env[p:top_end].max() if top_end > p else env[p]
        lo = max(0, p - int(sr * 0.03))
        seg = env[lo : p + 1]
        idx = np.where(seg <= 0.5 * top)[0]
        i = lo + (idx[-1] if len(idx) else 0)
        # Lineær interpolasjon mellom prøvene rundt halve nivået
        a, b = env[i], env[min(i + 1, len(env) - 1)]
        frac = (0.5 * top - a) / (b - a) if b != a else 0.0
        out.append((i + float(np.clip(frac, 0, 1))) / sr)
    return np.array(out)


# ---------------------------------------------------------------- takt-rutenett

def beat_grid(drums: np.ndarray, bass: np.ndarray, bpm_hint: float | None, duration_s: float, sr: int = SR) -> dict:
    """Første downbeat (ms), BPM og downbeat-tider (ms) takt for takt, fra kick-båndet i trommestammen."""
    kick = band(drums, 30, 150, sr)
    kick_on = onsets(kick, sr, smooth_ms=1.5, min_gap_ms=120, rel=0.3)
    # Båndpasset smører ut anslaget: tidspunktet hentes fra nærmeste bredbånds-anslag rett før (innen 25 ms)
    raw_on = onsets(drums, sr, smooth_ms=1.0, min_gap_ms=25, rel=0.1)
    if len(raw_on):
        fixed = []
        for k in kick_on:
            near = raw_on[(raw_on >= k - 0.025) & (raw_on <= k + 0.005)]
            fixed.append(float(near.min()) if len(near) else float(k))
        kick_on = np.array(fixed)
    bpm = float(bpm_hint) if bpm_hint and 60 <= bpm_hint <= 200 else estimate_bpm(kick_on, duration_s)
    if not bpm or len(kick_on) < 8:
        return {"bpm": bpm or None, "firstDownbeatMs": None, "bars": [], "barBpm": []}
    period = 60.0 / bpm
    # Fase: den som treffer flest kick-anslag (kam med toleranse 30 ms)
    phases = np.linspace(0, period, 96, endpoint=False)
    def score(ph):
        d = np.mod(kick_on - ph + period / 2, period) - period / 2
        return np.sum(np.exp(-0.5 * (d / 0.02) ** 2))
    phase = float(phases[int(np.argmax([score(p) for p in phases]))])
    # Slag for slag: hvert slag justeres mot nærmeste kick (±6 %), ellers videre i samme tempo
    beats = []
    t = phase
    while t < duration_s:
        near = kick_on[np.abs(kick_on - t) < 0.06 * period]
        if len(near):
            t = float(near[np.argmin(np.abs(near - t))])
        beats.append(t)
        t += period
    beats = np.array(beats)
    # Presist tempo: rett linje gjennom alle slagene (ikke bare kammen)
    if len(beats) >= 16:
        slope, icpt = np.polyfit(np.arange(len(beats)), beats, 1)
        if 0.95 < slope / period < 1.05:
            bpm = 60.0 / slope
    # Downbeat: av de fire mulige, den der bassen og kicken er sterkest på taktstart
    benv = envelope(band(bass, None, 250, sr), sr, 20)
    kenv = envelope(kick, sr, 10)
    def strength(i):
        s = 0.0
        for b in beats[i::4]:
            j = int(b * sr)
            if j < len(benv):
                s += benv[j: j + int(0.08 * sr)].mean() + kenv[j: j + int(0.05 * sr)].mean()
        return s
    off = int(np.argmax([strength(i) for i in range(4)]))
    bars = beats[off::4]
    raw = np.array([240.0 / (b2 - b1) for b1, b2 in zip(bars[:-1], bars[1:]) if b2 > b1])
    # Glatt over 8 takter (median), så små feil i kick-tidene ikke ser ut som tempoendringer
    bar_bpm = [round(float(np.median(raw[max(0, i - 4): i + 4])), 1) for i in range(len(raw))]
    return {"bpm": round(bpm, 2), "firstDownbeatMs": int(round(bars[0] * 1000)) if len(bars) else None, "bars": [int(round(b * 1000)) for b in bars], "barBpm": bar_bpm}


def estimate_bpm(on: np.ndarray, duration_s: float) -> float | None:
    """Tempo fra avstandene mellom anslag (60–180, house foretrekkes 115–135)."""
    if len(on) < 8:
        return None
    best, best_s = None, -1.0
    for bpm in np.arange(60, 180.01, 0.1):
        p = 60.0 / bpm
        d = np.mod(on + p / 2, p) - p / 2
        s = np.sum(np.exp(-0.5 * (d / 0.015) ** 2)) * (1.15 if 115 <= bpm <= 135 else 1.0)
        if s > best_s:
            best, best_s = bpm, s
    return float(best)


# ---------------------------------------------------------------- groove

def swing_percent(hats: np.ndarray, bpm: float, sr: int = SR) -> float | None:
    """
    Swing i prosent av en 16-del: hvor sent off-beat 16-delene (2. og 4. i hvert slag) kommer i forhold til rett
    takt. 0 = rett, 20 = 20 % av en 16-del for sent. Målt mellom nabo-anslag, så feil i rutenettet ikke teller.
    """
    on = onsets(band(hats, 6000, 10500, sr), sr, smooth_ms=1.0, min_gap_ms=40, rel=0.2)
    if len(on) < 16 or not bpm:
        return None
    s16 = 60.0 / bpm / 4
    delays = []
    for a, b in zip(on[:-1], on[1:]):
        gap = (b - a) / s16
        # Par som er nøyaktig ett 16-dels steg fra hverandre (på-slag → av-slag): 1 + swing
        if 0.75 < gap < 1.45:
            delays.append(gap - 1.0)
    if len(delays) < 8:
        return None
    d = np.array(delays)
    # Halvparten av parene er på→av (forsinket, positiv), halvparten av→på (negativ). Ta de positive.
    pos = d[d > -0.02]
    neg = -d[d < -0.02]
    val = np.median(pos) if len(pos) >= len(neg) else np.median(neg)
    return round(float(max(0.0, val)) * 100, 1)


def groove_features(drums: np.ndarray, bars_ms: list[int], bpm: float | None, sr: int = SR) -> dict:
    """Swing, perkusjonstetthet (anslag per takt, 0–1), 4/4-kick (andel slag med kick) og hat-lysstyrke (0–1)."""
    if not bpm:
        return {"swing": None, "density": None, "fourOnFloor": None, "hats": None}
    period = 60.0 / bpm
    all_on = onsets(drums, sr, smooth_ms=3, min_gap_ms=35, rel=0.2)
    dur = len(drums) / sr
    bars = max(1.0, dur / (4 * period))
    density = min(1.0, len(all_on) / bars / 32.0)
    kick_on = onsets(band(drums, 30, 150, sr), sr, smooth_ms=5, min_gap_ms=120, rel=0.3)
    four = None
    if bars_ms and len(kick_on):
        # Per takt: hvor mange av de fire slagene har kick? Takter uten kick (breaks, intro) teller ikke.
        counts = []
        for b in bars_ms:
            n = sum(1 for k in range(4) if np.min(np.abs(kick_on - (b / 1000 + k * period))) < 0.04)
            if n:
                counts.append(n)
        four = bool(np.mean(np.array(counts) == 4) >= 0.6) if len(counts) >= 4 else None
    hi = band(drums, 6000, None, sr)
    total = float(np.mean(drums ** 2)) + 1e-12
    hats = float(np.clip(np.mean(hi ** 2) / total * 12, 0, 1))
    return {"swing": swing_percent(drums, bpm, sr), "density": round(density, 3), "fourOnFloor": four, "hats": round(hats, 3)}


# ---------------------------------------------------------------- bass

def bass_features(bass: np.ndarray, bars_ms: list[int], sr: int = SR) -> dict:
    """Sub-andel (< 70 Hz av < 250 Hz), sustain (andel tid bassen holder seg oppe) og om den er aktiv i intro/outro."""
    if not len(bass) or np.max(np.abs(bass)) < 1e-5:
        return {"sub": None, "sustain": None, "introActive": False, "outroActive": False}
    sub = band(bass, None, 70, sr)
    low = band(bass, None, 250, sr)
    sub_ratio = float(np.mean(sub ** 2) / (np.mean(low ** 2) + 1e-12))
    env = envelope(low, sr, 25)
    p95 = np.percentile(env, 95) + 1e-12
    active = env > 0.15 * p95
    sustain = float(np.mean(env[active] > 0.4 * p95)) if np.any(active) else 0.0
    def active_in(t0: float, t1: float) -> bool:
        seg = env[int(t0 * sr): int(t1 * sr)]
        return bool(len(seg) and np.mean(seg > 0.25 * p95) > 0.3)
    dur = len(bass) / sr
    span = 16 * (bars_ms[1] - bars_ms[0]) / 1000 if len(bars_ms) > 1 else 30.0
    start = bars_ms[0] / 1000 if bars_ms else 0.0
    return {"sub": round(min(1.0, sub_ratio), 3), "sustain": round(sustain, 3), "introActive": active_in(start, start + span), "outroActive": active_in(max(0, dur - span), dur)}


# ---------------------------------------------------------------- vokal

def vocal_map(vocals: np.ndarray, mix: np.ndarray, sr: int = SR, frame_ms: int = 100, min_ms: int = 800, gap_ms: int = 1500) -> list[list[int]]:
    """Tidsintervaller (ms) med vokal: vokalstammen tydelig over sitt eget støygulv og ikke bare lekkasje fra miksen."""
    n = int(sr * frame_ms / 1000)
    frames = len(vocals) // n
    if frames == 0:
        return []
    v = np.sqrt(np.mean(vocals[: frames * n].reshape(frames, n) ** 2, axis=1))
    m = np.sqrt(np.mean(mix[: frames * n].reshape(frames, n) ** 2, axis=1)) + 1e-9
    peak = np.percentile(v, 98) + 1e-9
    on = (v > 0.12 * peak) & (v / m > 0.12)
    out: list[list[int]] = []
    start = None
    for i, x in enumerate(np.append(on, False)):
        if x and start is None:
            start = i
        elif not x and start is not None:
            out.append([start * frame_ms, i * frame_ms])
            start = None
    merged: list[list[int]] = []
    for s, e in out:
        if merged and s - merged[-1][1] < gap_ms:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [[s, e] for s, e in merged if e - s >= min_ms]


def clean_ends(bars_ms: list[int], duration_ms: int, vocals: list[list[int]], bass_env_active) -> dict:
    """Ren intro/outro i hele takter: uten vokal, og (strengere) uten bass. Rundet ned til 4 takter."""
    if len(bars_ms) < 2:
        return {"intro": None, "outro": None, "introNoBass": None, "outroNoBass": None}
    bar = (bars_ms[-1] - bars_ms[0]) / max(1, len(bars_ms) - 1)
    first_vocal = vocals[0][0] if vocals else duration_ms
    last_vocal = vocals[-1][1] if vocals else 0
    intro = max(0, int((first_vocal - bars_ms[0]) // bar))
    outro = max(0, int((duration_ms - last_vocal) // bar))
    intro_nb = 0
    for i, b in enumerate(bars_ms):
        if b >= first_vocal or bass_env_active(b, b + bar):
            break
        intro_nb = i + 1
    outro_nb = 0
    for b in reversed(bars_ms):
        if b + bar <= last_vocal or bass_env_active(b, b + bar):
            break
        outro_nb += 1
    r4 = lambda x: int(x // 4 * 4)
    return {"intro": r4(intro), "outro": r4(outro), "introNoBass": r4(intro_nb), "outroNoBass": r4(outro_nb)}


def analyze_stems(stems: dict, mix: np.ndarray, bpm_hint: float | None, sr: int = SR) -> dict:
    """Hele analysen fra stemmene (mono numpy, samme lengde og samplerate)."""
    dur_s = len(mix) / sr
    grid = beat_grid(stems["drums"], stems["bass"], bpm_hint, dur_s, sr)
    bpm = grid["bpm"]
    groove = groove_features(stems["drums"], grid["bars"], bpm, sr)
    bassf = bass_features(stems["bass"], grid["bars"], sr)
    vocals = vocal_map(stems["vocals"], mix, sr)
    low = envelope(band(stems["bass"], None, 250, sr), sr, 25)
    p95 = np.percentile(low, 95) + 1e-12 if len(low) else 1.0
    def bass_active(t0_ms: float, t1_ms: float) -> bool:
        seg = low[int(t0_ms / 1000 * sr): int(t1_ms / 1000 * sr)]
        return bool(len(seg) and np.mean(seg > 0.25 * p95) > 0.3)
    ends = clean_ends(grid["bars"], int(dur_s * 1000), vocals, bass_active)
    vocal_share = sum(e - s for s, e in vocals) / max(1.0, dur_s * 1000)
    return {"schema": 1, "grid": grid, "groove": groove, "bass": bassf, "vocals": vocals, "vocalShare": round(vocal_share, 3), "ends": ends}
