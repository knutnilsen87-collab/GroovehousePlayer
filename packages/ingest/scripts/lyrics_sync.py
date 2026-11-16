#!/usr/bin/env python3
"""
Groovehouse Vault – Vokal-separering (Demucs) + Ord-synkronisert transkribering (WhisperX).

Bruk:
  python lyrics_sync.py <lydfil> <ut_json> [--lrc <ut_lrc>] [--model large-v2] [--language en]

Steg:
  1. Isolerer vokalen med Demucs (`demucs --two-stems vocals`) i en midlertidig mappe
     slik at tunge house-beats ikke forstyrrer talegjenkjenningen.
  2. Kjører WhisperX med tvungen ord-tidsstempling (word-level forced alignment).
  3. Skriver ut strukturert JSON (`[{ "word": "...", "start": 1.24, "end": 1.58 }, ...]`)
     og valgfri Enhanced LRC-fil med ord-tagger (`[00:01.24] <00:01.24>Ord ...`).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile


def fmt_lrc_time(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    minutes = ms_total // 60000
    secs = (ms_total % 60000) // 1000
    hundredths = (ms_total % 1000) // 10
    return f"{minutes:02d}:{secs:02d}.{hundredths:02d}"


def isolate_vocals(audio_path: str, temp_dir: str) -> str:
    """Kjører Demucs two-stems (vocals) hvis installert; ellers returneres original lydfil."""
    demucs_bin = shutil.which("demucs")
    if not demucs_bin:
        print("! Demucs ble ikke funnet i PATH – transkriberer direkte fra master-lydfil.", file=sys.stderr)
        return audio_path

    track_name = os.path.splitext(os.path.basename(audio_path))[0]
    print(f"Isolerer vokal for {track_name} med Demucs...", file=sys.stderr)
    try:
        subprocess.run(
            [demucs_bin, "--two-stems", "vocals", "-o", temp_dir, audio_path],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for model_dir in ("htdemucs", "htdemucs_ft", "mdx_extra"):
            candidate = os.path.join(temp_dir, model_dir, track_name, "vocals.wav")
            if os.path.isfile(candidate):
                return candidate
    except Exception as exc:
        print(f"! Demucs feilet ({exc}) – faller tilbake til original lydfil.", file=sys.stderr)

    return audio_path


def transcribe_with_whisperx(vocal_path: str, model_name: str = "large-v2", language: str | None = None):
    import torch  # type: ignore
    import whisperx  # type: ignore

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    print(f"Kjører grov-transkribering med WhisperX ({model_name} på {device})...", file=sys.stderr)
    model = whisperx.load_model(model_name, device, compute_type=compute_type, language=language)
    audio = whisperx.load_audio(vocal_path)
    result = model.transcribe(audio, batch_size=16 if device == "cuda" else 4)

    lang = result.get("language") or language or "en"
    print(f"Tvinger tidsstempler på ordnivå (språk: {lang})...", file=sys.stderr)
    model_a, metadata = whisperx.load_align_model(language_code=lang, device=device)
    aligned = whisperx.align(
        result["segments"],
        model_a,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )
    return aligned.get("segments", [])


def generate_lyrics_sync(audio_path: str, output_json: str, output_lrc: str | None = None, model_name: str = "large-v2", language: str | None = None):
    with tempfile.TemporaryDirectory(prefix="gv_demucs_") as temp_dir:
        vocal_path = isolate_vocals(audio_path, temp_dir)
        segments = transcribe_with_whisperx(vocal_path, model_name=model_name, language=language)

        lyrics_data = []
        lrc_lines = []

        for segment in segments:
            seg_words = []
            for word in segment.get("words", []):
                w_text = str(word.get("word", "")).strip()
                if not w_text or "start" not in word or "end" not in word:
                    continue
                start_s = round(float(word["start"]), 3)
                end_s = round(float(word["end"]), 3)
                entry = {"word": w_text, "start": start_s, "end": end_s}
                lyrics_data.append(entry)
                seg_words.append(entry)

            if seg_words:
                line_start = fmt_lrc_time(seg_words[0]["start"])
                inline_words = " ".join(f"<{fmt_lrc_time(w['start'])}>{w['word']}" for w in seg_words)
                lrc_lines.append(f"[{line_start}]{inline_words}")

        os.makedirs(os.path.dirname(os.path.abspath(output_json)), exist_ok=True)
        with open(output_json, "w", encoding="utf-8") as f:
            json.dump(lyrics_data, f, ensure_ascii=False, indent=2)

        if output_lrc:
            os.makedirs(os.path.dirname(os.path.abspath(output_lrc)), exist_ok=True)
            with open(output_lrc, "w", encoding="utf-8") as f:
                f.write("\n".join(lrc_lines) + "\n")

        print(f"Lyrics-data lagret: {output_json} ({len(lyrics_data)} ord)", file=sys.stderr)
        return lyrics_data


def main():
    parser = argparse.ArgumentParser(description="Isoler vokal med Demucs og synkroniser ord med WhisperX.")
    parser.add_argument("audio_path", help="Sti til lydfil (WAV/FLAC/MP3)")
    parser.add_argument("output_json", help="Sti til utdata JSON-fil")
    parser.add_argument("--lrc", dest="output_lrc", default=None, help="Valgfri sti til Enhanced LRC-fil")
    parser.add_argument("--model", default="large-v2", help="WhisperX-modell (standard: large-v2)")
    parser.add_argument("--language", default=None, help="Valgfri språkkode (f.eks. en, no)")
    args = parser.parse_args()

    if not os.path.isfile(args.audio_path):
        print(f"Fant ikke lydfil: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    generate_lyrics_sync(
        audio_path=args.audio_path,
        output_json=args.output_json,
        output_lrc=args.output_lrc,
        model_name=args.model,
        language=args.language,
    )


if __name__ == "__main__":
    main()
