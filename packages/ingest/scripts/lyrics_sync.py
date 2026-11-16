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


def main():
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
