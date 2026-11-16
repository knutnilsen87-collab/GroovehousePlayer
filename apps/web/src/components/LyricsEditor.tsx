import { useEffect, useRef, useState } from 'react';
import { formatTimeMs, parseLyrics, parseLyricWords } from '@gv/shared/web';
import type { LoadedAsset } from '../lib/catalog';
import { fetchLyrics, saveLyrics, transcribeLyrics } from '../lib/library';
import { getPositionMs, usePlayer } from '../lib/player';

/** «[01:02.50]» fra posisjonen nå – til å synkronisere linje for linje mens låta spilles. */
const stamp = (ms: number) => `[${formatTimeMs(ms).replace(/^(\d+:)?/, '').slice(0, 8)}]`;

/**
 * Del 14 pkt. 16: sangtekst per låt i Studio. LRC (synkronisert), WhisperX JSON (ord-synkronisert)
 * eller ren tekst, lagret i data/lyrics/<slug>.lrc|.txt på PC-en.
 */
export function LyricsEditor({ a }: { a: LoadedAsset }) {
  const slug = a.manifest.slug;
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const isCur = usePlayer((s) => s.queue[s.index]?.manifest.slug === slug);
  useEffect(() => {
    let alive = true;
    void fetchLyrics(slug, true).then((l) => {
      if (!alive) return;
      setText(l?.text.trimEnd() ?? '');
      setSaved(l?.text.trimEnd() ?? '');
    });
    return () => {
      alive = false;
    };
  }, [slug]);
  if (text === null) return <p className="m-0 text-xs text-muted">Henter tekst …</p>;
  const parsed = parseLyrics(text);
  const wordParsed = parseLyricWords(text, a.manifest.durationMs);
  const format = parsed.synced ? 'lrc' : 'txt';
  const dirty = text !== saved;

  /** Sett tidsstempel fra spillehodet på linja markøren står i. */
  const stampLine = (ta: HTMLTextAreaElement) => {
    const at = ta.selectionStart;
    const start = text.lastIndexOf('\n', at - 1) + 1;
    const end = text.indexOf('\n', at);
    const line = text.slice(start, end === -1 ? undefined : end).replace(/^(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/, '');
    const next = text.slice(0, start) + stamp(getPositionMs()) + line + text.slice(end === -1 ? text.length : end);
    setText(next);
    // Gå til neste linje, så Ctrl+Enter kan trykkes i takt med låta
    requestAnimationFrame(() => {
      const nl = next.indexOf('\n', start);
      const pos = nl === -1 ? next.length : nl + 1;
      ta.setSelectionRange(pos, pos);
    });
  };

  const handleImportFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const raw = await f.text();
      setText(raw.trimEnd());
      setMsg({ ok: true, text: `Leste inn «${f.name}» – klikk «Lagre tekst» for å bekrefte.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <section aria-label="Sangtekst" className="flex flex-col gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="gv-label m-0">Tekst & Karaoke-synk</h3>
          {wordParsed.wordSynced && (
            <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-accent">
              ORD-SYNK ({wordParsed.words.length} ord)
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-muted">
            {text.trim()
              ? wordParsed.wordSynced
                ? `WhisperX / Enhanced LRC · ${wordParsed.words.length} ord · ${parsed.lines.length} linjer`
                : parsed.synced
                  ? `LRC · ${parsed.lines.length} synkroniserte linjer`
                  : `Ren tekst · ${parsed.lines.length} linjer`
              : 'Ingen tekst'}
          </span>
          <button
            type="button"
            disabled={transcribing || busy}
            onClick={async () => {
              setTranscribing(true);
              setMsg({ ok: true, text: 'Isolerer vokal (Demucs) og synkroniserer ord (WhisperX) …' });
              try {
                const res = await transcribeLyrics(slug);
                const clean = res.data.text.trimEnd();
                setText(clean);
                setSaved(clean);
                setMsg({ ok: true, text: `Ferdig! ${res.wordCount} ord synkronisert og lagret.` });
              } catch (err) {
                setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
              } finally {
                setTranscribing(false);
              }
            }}
            className="h-7 rounded-full border border-accent/50 bg-accent/10 px-3 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            {transcribing ? 'Transkriberer …' : 'Auto-transkriber (Demucs + WhisperX)'}
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="h-7 rounded-full border border-white/15 bg-sunken px-2.5 text-[11px] text-soft hover:border-white/30 hover:text-ink-strong"
          >
            Importer .json / .lrc …
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".lrc,.json,.txt"
            className="sr-only"
            tabIndex={-1}
            aria-label="Importer sangtekstfil"
            onChange={(e) => void handleImportFile(e.target.files?.[0])}
          />
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isCur) {
            e.preventDefault();
            stampLine(e.currentTarget);
          }
        }}
        rows={8}
        spellCheck={false}
        aria-label={`Sangtekst for ${a.manifest.title}`}
        placeholder={'Lim inn LRC ([00:12.50]Linje), WhisperX JSON ([{ "word": "Feel", "start": 1.2, "end": 1.5 }]) eller ren tekst.'}
        className="gv-scroll w-full resize-y rounded-lg border border-white/10 bg-[#0A0B0F] p-3 font-mono text-[13px] leading-relaxed text-ink focus:border-accent/60 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await saveLyrics(slug, format, text);
              setSaved(r?.text.trimEnd() ?? '');
              setText(r?.text.trimEnd() ?? '');
              setMsg({ ok: true, text: r ? `Lagret som ${r.format.toUpperCase()}` : 'Teksten er fjernet' });
            } catch (err) {
              setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
            } finally {
              setBusy(false);
            }
          }}
          className="h-9 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40"
        >
          Lagre tekst
        </button>
        {dirty && (
          <button type="button" onClick={() => setText(saved)} className="h-9 rounded-full border border-white/10 px-3 text-sm text-soft hover:text-ink">
            Angre endringer
          </button>
        )}
        <span className="text-[11px] text-muted">{isCur ? 'Ctrl+Enter setter tidsstempel fra spillehodet på linja og går videre.' : 'Spill låta for å synkronisere med Ctrl+Enter.'}</span>
        {msg && <span className={`text-xs ${msg.ok ? 'text-accent' : 'text-[#FF8A7A]'}`}>{msg.text}</span>}
      </div>
    </section>
  );
}
