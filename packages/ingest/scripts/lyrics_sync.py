#!/usr/bin/env python3
"""
Groovehouse Vault – Vokal-separering (Demucs) + ord-synkronisert tekst (WhisperX).

Bruk:
  python lyrics_sync.py <lydfil> <ut_json> [--lrc <ut_lrc>] [--text <tekstfil>] [--model large-v2] [--language en]

To moduser:
  - Uten --text: transkriberer vokalen fra lyden (Whisper) og tvinger ordtider (forced alignment).
  - Med --text:  bruker Knuts egen tekst og beregner BARE ordtidene (forced alignment med wav2vec2).
                 Linjene i teksten beholdes som linjer i LRC-fila.

Steg:
  1. Isolerer vokalen med Demucs (two-stems vocals) i en midlertidig mappe, så house-beatet ikke
     forstyrrer. Demucs kjøres med samme Python som dette skriptet (venv-en .venv-lyrics).
  2. WhisperX: transkribering + ordtider, eller bare ordtider for gitt tekst.
  3. Skriver JSON (`[{ "word": "...", "start": 1.24, "end": 1.58 }, ...]`) og valgfri Enhanced LRC
     (`[00:01.24]<00:01.24>Ord <00:01.58>ord ...`).

Fremdrift skrives til stderr som linjer «STAGE: <navn>», som Vault-serveren viser i Studio.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile


def stage(name: str) -> None:
    print(f"STAGE: {name}", file=sys.stderr, flush=True)


def fmt_lrc_time(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    minutes = ms_total // 60000
    secs = (ms_total % 60000) // 1000
    hundredths = (ms_total % 1000) // 10
    return f"{minutes:02d}:{secs:02d}.{hundredths:02d}"


def isolate_vocals(audio_path: str, temp_dir: str) -> str:
    """Demucs two-stems (vocals) via `python -m demucs`; faller tilbake til original lydfil."""
    stage("demucs")
    track_name = os.path.splitext(os.path.basename(audio_path))[0]
    print(f"Isolerer vokal for {track_name} med Demucs...", file=sys.stderr, flush=True)
    try:
        subprocess.run(
            [sys.executable, "-m", "demucs", "--two-stems", "vocals", "-o", temp_dir, audio_path],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for model_dir in ("htdemucs", "htdemucs_ft", "mdx_extra"):
            candidate = os.path.join(temp_dir, model_dir, track_name, "vocals.wav")
            if os.path.isfile(candidate):
                return candidate
        print("! Fant ikke vocals.wav fra Demucs – bruker original lydfil.", file=sys.stderr)
    except Exception as exc:
        detail = getattr(exc, "stderr", b"") or b""
        tail = detail.decode("utf-8", "replace").strip().splitlines()[-1:] if detail else []
        print(f"! Demucs feilet ({exc}{': ' + tail[0] if tail else ''}) – bruker original lydfil.", file=sys.stderr)
    return audio_path


def _device():
    import torch  # type: ignore

    device = "cuda" if torch.cuda.is_available() else "cpu"
    return device, ("float16" if device == "cuda" else "int8")


def _align(segments, audio, lang: str, device: str):
    import whisperx  # type: ignore

    stage("align")
    print(f"Tvinger tidsstempler på ordnivå (språk: {lang})...", file=sys.stderr, flush=True)
    model_a, metadata = whisperx.load_align_model(language_code=lang, device=device)
    aligned = whisperx.align(segments, model_a, metadata, audio, device, return_char_alignments=False)
    return aligned.get("segments", [])


def transcribe_with_whisperx(vocal_path: str, model_name: str, language: str | None):
    import whisperx  # type: ignore

    device, compute_type = _device()
    stage("transcribe")
    print(f"Transkriberer med WhisperX ({model_name} på {device})...", file=sys.stderr, flush=True)
    model = whisperx.load_model(model_name, device, compute_type=compute_type, language=language)
    audio = whisperx.load_audio(vocal_path)
    result = model.transcribe(audio, batch_size=16 if device == "cuda" else 4)
    lang = result.get("language") or language or "en"
    return _align(result["segments"], audio, lang, device), lang


def align_known_text(vocal_path: str, text: str, language: str | None):
    """Bare ordtider for kjent tekst. Språket oppdages med en liten Whisper-modell hvis det ikke er gitt."""
    import whisperx  # type: ignore

    device, compute_type = _device()
    audio = whisperx.load_audio(vocal_path)
    lang = language
    if not lang:
        stage("language")
        small = whisperx.load_model("base", device, compute_type=compute_type)
        lang = small.detect_language(audio) or "en"
        del small
    duration = len(audio) / 16000.0
    flat = " ".join(line.strip() for line in text.splitlines() if line.strip())
    segments = [{"text": flat, "start": 0.0, "end": duration}]
    return _align(segments, audio, lang, device), lang


def words_of(segments):
    out = []
    for segment in segments:
        for word in segment.get("words", []):
            w_text = str(word.get("word", "")).strip()
            if not w_text or "start" not in word or "end" not in word:
                continue
            out.append({"word": w_text, "start": round(float(word["start"]), 3), "end": round(float(word["end"]), 3)})
    return out


def lrc_from_segments(segments):
    lines = []
    for segment in segments:
        ws = words_of([segment])
        if ws:
            lines.append(f"[{fmt_lrc_time(ws[0]['start'])}]" + " ".join(f"<{fmt_lrc_time(w['start'])}>{w['word']}" for w in ws))
    return lines


def lrc_from_text_lines(text: str, words):
    """Beholder Knuts linjer: ordene fordeles på linjene i rekkefølge (samme antall ord per linje som i teksten)."""
    lines = []
    i = 0
    for raw in text.splitlines():
        tokens = raw.split()
        if not tokens:
            continue
        chunk = words[i : i + len(tokens)]
        i += len(tokens)
        if not chunk:
            break
        # Behold originalordene (tegnsetting/store bokstaver) med tidene fra alignment
        parts = [f"<{fmt_lrc_time(w['start'])}>{tok}" for tok, w in zip(tokens, chunk)]
        lines.append(f"[{fmt_lrc_time(chunk[0]['start'])}]" + " ".join(parts))
    return lines


def generate_lyrics_sync(audio_path, output_json, output_lrc=None, model_name="large-v2", language=None, text=None):
    with tempfile.TemporaryDirectory(prefix="gv_demucs_") as temp_dir:
        vocal_path = isolate_vocals(audio_path, temp_dir)
        if text:
            segments, lang = align_known_text(vocal_path, text, language)
            words = words_of(segments)
            # Alignment kan slå sammen/dele tokens annerledes enn mellomrom; fall tilbake til segmentene da
            lrc_lines = lrc_from_text_lines(text, words) if len(words) == len(" ".join(text.split()).split()) else lrc_from_segments(segments)
        else:
            segments, lang = transcribe_with_whisperx(vocal_path, model_name, language)
            words = words_of(segments)
            lrc_lines = lrc_from_segments(segments)

        stage("write")
        os.makedirs(os.path.dirname(os.path.abspath(output_json)), exist_ok=True)
        with open(output_json, "w", encoding="utf-8") as f:
            json.dump(words, f, ensure_ascii=False, indent=2)
        if output_lrc:
            os.makedirs(os.path.dirname(os.path.abspath(output_lrc)), exist_ok=True)
            with open(output_lrc, "w", encoding="utf-8") as f:
                f.write("\n".join(lrc_lines) + ("\n" if lrc_lines else ""))
        print(f"Lyrics-data lagret: {output_json} ({len(words)} ord, språk {lang})", file=sys.stderr, flush=True)
        return words


# ---------------------------------------------------------------- vedvarende modus (--serve)
#
# Vault-serveren holder én Python-prosess i live mens det er jobber, så Demucs-, Whisper- og align-modellene
# lastes én gang (ikke per låt). Én JSON-linje inn per jobb på stdin, én JSON-linje ut på stdout.
# Fremdrift på stderr: «STAGE: <jobb-id> <navn>». Prosessen avsluttes når stdin lukkes.

INSTRUMENTAL_RATIO = 0.06  # vokal-RMS / miks-RMS under dette = instrumental (ingen WhisperX)


class Models:
    def __init__(self):
        import torch  # type: ignore

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.compute_type = "float16" if self.device == "cuda" else "int8"
        self.demucs = None
        self.whisper = {}
        self.align = {}
        self.detector = None

    def separate(self, audio_path: str):
        """Vokalen (mono 16 kHz, numpy) og forholdet vokal/miks, med Demucs i samme prosess."""
        import torchaudio  # type: ignore
        from demucs.apply import apply_model  # type: ignore
        from demucs.audio import AudioFile  # type: ignore
        from demucs.pretrained import get_model  # type: ignore

        if self.demucs is None:
            self.demucs = get_model("htdemucs")
            self.demucs.to(self.device)
            self.demucs.eval()
        m = self.demucs
        wav = AudioFile(audio_path).read(streams=0, samplerate=m.samplerate, channels=m.audio_channels)
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        with self.torch.no_grad():
            sources = apply_model(m, ((wav - mean) / std)[None], device=self.device, split=True, overlap=0.25, progress=False)[0]
        sources = sources * std + mean
        vocals = sources[m.sources.index("vocals")].mean(0)
        mix = wav.mean(0)
        ratio = float(vocals.pow(2).mean().sqrt() / (mix.pow(2).mean().sqrt() + 1e-8))
        v16 = torchaudio.functional.resample(vocals.cpu(), m.samplerate, 16000).numpy().astype("float32")
        return v16, ratio

    def whisper_model(self, name: str, language):
        import whisperx  # type: ignore

        key = (name, language)
        if key not in self.whisper:
            self.whisper[key] = whisperx.load_model(name, self.device, compute_type=self.compute_type, language=language)
        return self.whisper[key]

    def align_model(self, lang: str):
        import whisperx  # type: ignore

        if lang not in self.align:
            self.align[lang] = whisperx.load_align_model(language_code=lang, device=self.device)
        return self.align[lang]


def serve():
    import whisperx  # type: ignore

    models = Models()
    print(json.dumps({"ready": True, "device": models.device}), flush=True)
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        job = json.loads(raw)
        jid = job.get("id", "")
        st = lambda name: print(f"STAGE: {jid} {name}", file=sys.stderr, flush=True)
        try:
            st("demucs")
            audio, ratio = models.separate(job["audio"])
            if ratio < INSTRUMENTAL_RATIO and not job.get("text"):
                print(json.dumps({"id": jid, "ok": True, "instrumental": True, "ratio": round(ratio, 4), "words": 0}), flush=True)
                continue
            text = (job.get("text") or "").strip()
            language = job.get("language")
            if text:
                lang = language
                if not lang:
                    st("language")
                    lang = models.whisper_model("base", None).detect_language(audio) or "en"
                segments_in = [{"text": " ".join(l.strip() for l in text.splitlines() if l.strip()), "start": 0.0, "end": len(audio) / 16000.0}]
            else:
                st("transcribe")
                res = models.whisper_model(job.get("model") or "large-v2", language).transcribe(audio, batch_size=16 if models.device == "cuda" else 4)
                segments_in = res["segments"]
                lang = res.get("language") or language or "en"
            st("align")
            model_a, meta = models.align_model(lang)
            segments = whisperx.align(segments_in, model_a, meta, audio, models.device, return_char_alignments=False).get("segments", [])
            words = words_of(segments)
            if text and len(words) == len(" ".join(text.split()).split()):
                lrc = lrc_from_text_lines(text, words)
            else:
                lrc = lrc_from_segments(segments)
            st("write")
            with open(job["out_json"], "w", encoding="utf-8") as f:
                json.dump(words, f, ensure_ascii=False, indent=2)
            with open(job["out_lrc"], "w", encoding="utf-8") as f:
                f.write("\n".join(lrc) + ("\n" if lrc else ""))
            print(json.dumps({"id": jid, "ok": True, "instrumental": False, "ratio": round(ratio, 4), "words": len(words), "language": lang}), flush=True)
        except Exception as exc:  # noqa: BLE001 – rapporteres til Vault, prosessen lever videre
            print(json.dumps({"id": jid, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]}), flush=True)


def main():
    if "--serve" in sys.argv:
        serve()
        return
    parser = argparse.ArgumentParser(description="Isoler vokal med Demucs og synkroniser ord med WhisperX.")
    parser.add_argument("audio_path", help="Sti til lydfil (WAV/FLAC/MP3)")
    parser.add_argument("output_json", help="Sti til utdata JSON-fil")
    parser.add_argument("--lrc", dest="output_lrc", default=None, help="Valgfri sti til Enhanced LRC-fil")
    parser.add_argument("--text", dest="text_file", default=None, help="Kjent tekst (UTF-8): bare ordtidene beregnes")
    parser.add_argument("--model", default="large-v2", help="WhisperX-modell (standard: large-v2)")
    parser.add_argument("--language", default=None, help="Valgfri språkkode (f.eks. en, no)")
    args = parser.parse_args()

    if not os.path.isfile(args.audio_path):
        print(f"Fant ikke lydfil: {args.audio_path}", file=sys.stderr)
        sys.exit(1)
    text = None
    if args.text_file:
        with open(args.text_file, encoding="utf-8-sig") as f:
            # Fjern eventuelle LRC-tidsstempler hvis teksten er limt inn som LRC
            text = re.sub(r"\[\d+:\d+(?:\.\d+)?\]|<\d+:\d+(?:\.\d+)?>", "", f.read()).strip()
        if not text:
            text = None

    generate_lyrics_sync(args.audio_path, args.output_json, args.output_lrc, args.model, args.language, text)


if __name__ == "__main__":
    main()
