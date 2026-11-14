import { useState } from 'react';
import { Logo } from '../components/Brand';
import { normalizeServer } from '../lib/connection';
import { forgetConnection, pairDevice } from '../lib/platform';

/**
 * Android-appen, første oppstart: «Koble til Vault». Adressen (Tailscale) og PIN-en gir et enhetstoken
 * som lagres kryptert i appen. Adressen ligger aldri i koden – bare i appen etter at du har lagt den inn.
 */
export function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const [server, setServer] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center bg-obsidian px-6 py-10 text-ink">
      <Logo size={56} />
      <h1 className="mb-1 mt-8 font-display text-[28px] font-semibold uppercase tracking-[1.5px] text-ink-strong">Koble til Vault</h1>
      <p className="m-0 mb-6 max-w-[340px] text-center text-sm text-muted">Tailscale må være på. Adressen står i Studio → Mobil eller får du med «pnpm vault:remote status» på PC-en.</p>
      <form
        className="flex w-full max-w-[360px] flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const s = normalizeServer(server);
          if (!s) return setError('Skriv adressen, f.eks. pc-navn.tailnet.ts.net (bare HTTPS).');
          if (!/^\d{6,12}$/.test(pin)) return setError('PIN-en er 6–12 sifre (den samme som for Wi-Fi-modus).');
          setBusy(true);
          setError(null);
          try {
            await pairDevice(s, pin, 'Android');
            onConnected();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          Adresse til Vault
          <input value={server} onChange={(e) => setServer(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="pc-navn.tailnet.ts.net" className="h-12 rounded-xl border border-white/10 bg-surface px-4 text-[15px] text-ink-strong placeholder:text-muted/60 focus:border-gold/60 focus:outline-none" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          PIN
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" type="password" autoComplete="off" maxLength={12} className="h-12 rounded-xl border border-white/10 bg-surface px-4 text-[15px] tracking-[4px] text-ink-strong focus:border-gold/60 focus:outline-none" />
        </label>
        {error && (
          <p role="alert" className="m-0 rounded-xl border border-[#FF8A7A]/40 bg-[#FF8A7A]/[0.07] px-3 py-2 text-sm text-[#FFB4A8]">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="mt-2 h-12 rounded-full bg-gold text-sm font-semibold text-[#120D02] disabled:opacity-50">
          {busy ? 'Kobler til …' : 'Koble til'}
        </button>
      </form>
    </main>
  );
}

/** Appen får ikke kontakt (PC-en av, Tailscale av, eller enheten er trukket tilbake). */
export function UnreachableScreen({ error, onRetry, onReconnect }: { error: string; onRetry: () => void; onReconnect: () => void }) {
  const revoked = /^401 /.test(error);
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center bg-obsidian px-6 text-center text-ink">
      <Logo size={48} />
      <h1 className="mb-2 mt-8 text-lg font-semibold text-ink-strong">{revoked ? 'Enheten er ikke godkjent lenger' : 'Får ikke kontakt med Vault på PC-en'}</h1>
      <p className="m-0 mb-6 max-w-[320px] text-sm text-muted">
        {revoked ? 'Den er trukket tilbake på PC-en. Koble til på nytt med PIN-en.' : 'Sjekk at PC-en står på, at Vault kjører, og at Tailscale er på på telefonen.'}
      </p>
      <div className="flex gap-3">
        {!revoked && (
          <button type="button" onClick={onRetry} className="h-12 rounded-full bg-gold px-6 text-sm font-semibold text-[#120D02]">
            Prøv igjen
          </button>
        )}
        <button
          type="button"
          onClick={async () => {
            await forgetConnection();
            onReconnect();
          }}
          className="h-12 rounded-full border border-white/15 px-5 text-sm text-ink"
        >
          Koble til på nytt
        </button>
      </div>
    </main>
  );
}
