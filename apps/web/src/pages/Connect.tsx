import { useEffect, useRef, useState } from 'react';
import { Logo } from '../components/Brand';
import { explainAddress, explainHealth, type ConnectHelp } from '../lib/connectErrors';
import { normalizeServer } from '../lib/connection';
import { forgetConnection, pairDevice, probeVault } from '../lib/platform';

/**
 * Android-appen, første oppstart (del 12, trinnvis fra del 27):
 *   1. Er Tailscale på?  2. Adresse  3. PIN  4. Test forbindelsen
 * Steget og adressen huskes (kan gjenopptas). PIN-en lagres aldri – bare enhetstokenet, kryptert i appen.
 */
type Step = 1 | 2 | 3 | 4;
const RESUME_KEY = 'gv:connect:v1';

function readResume(): { step: Step; server: string } {
  try {
    const j = JSON.parse(localStorage.getItem(RESUME_KEY) ?? 'null') as { step?: number; server?: string } | null;
    const step = (j?.step && j.step >= 1 && j.step <= 3 ? j.step : 1) as Step;
    return { step, server: typeof j?.server === 'string' ? j.server : '' };
  } catch {
    return { step: 1, server: '' };
  }
}
function saveResume(step: Step, server: string) {
  try {
    // Steg 4 gjenopptas som steg 3 (PIN-en må skrives på nytt)
    localStorage.setItem(RESUME_KEY, JSON.stringify({ step: Math.min(step, 3), server }));
  } catch {
    /* uten lagring */
  }
}
function clearResume() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* uten lagring */
  }
}

const STEPS: Array<[Step, string]> = [
  [1, 'Tailscale'],
  [2, 'Adresse'],
  [3, 'PIN'],
  [4, 'Test']
];

const input = 'h-12 w-full rounded-xl border border-white/10 bg-surface px-4 text-[15px] text-ink-strong placeholder:text-muted/60 focus:border-accent/60 focus:outline-none';
const primary = 'h-12 w-full rounded-full bg-accent text-sm font-semibold text-on-accent disabled:opacity-50';
const ghost = 'h-12 rounded-full border border-white/15 px-5 text-sm text-ink';

export function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const resume = useRef(readResume()).current;
  const [step, setStepState] = useState<Step>(resume.step);
  const [server, setServer] = useState(resume.server);
  const [pin, setPin] = useState('');
  const [help, setHelp] = useState<ConnectHelp | null>(null);
  const [checks, setChecks] = useState<{ found: 'wait' | 'ok' | 'fail' | null; pin: 'wait' | 'ok' | 'fail' | null }>({ found: null, pin: null });
  const heading = useRef<HTMLHeadingElement>(null);
  const setStep = (s: Step) => {
    setStepState(s);
    saveResume(s, server);
  };
  // Nytt steg: skjermleser og tastatur starter på overskriften
  useEffect(() => heading.current?.focus({ preventScroll: true }), [step]);

  const runTest = async () => {
    const s = normalizeServer(server);
    if (!s) {
      setHelp(explainAddress(server, s));
      return;
    }
    setHelp(null);
    setChecks({ found: 'wait', pin: null });
    const health = explainHealth(s, await probeVault(s));
    if (health) {
      setChecks({ found: 'fail', pin: null });
      setHelp(health);
      return;
    }
    setChecks({ found: 'ok', pin: 'wait' });
    const pair = await pairDevice(s, pin, 'Android');
    if (pair) {
      setChecks({ found: 'ok', pin: pair.problem === 'wrong-pin' || pair.problem === 'rate-limited' || pair.problem === 'no-pin' ? 'fail' : null });
      setHelp(pair);
      return;
    }
    setChecks({ found: 'ok', pin: 'ok' });
    clearResume();
    onConnected();
  };

  return (
    <main className="flex min-h-[100svh] flex-col items-center bg-obsidian px-6 py-10 text-ink">
      <Logo size={48} />
      <h1 className="mb-1 mt-6 font-display text-[26px] font-semibold uppercase tracking-[1.5px] text-ink-strong">Koble til Vault</h1>
      <ol aria-label="Steg" className="m-0 mb-6 flex list-none gap-2 p-0">
        {STEPS.map(([n, label]) => (
          <li key={n} aria-current={n === step ? 'step' : undefined} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] ${n === step ? 'bg-accent/[0.14] font-semibold text-accent' : n < step ? 'text-soft' : 'text-muted'}`}>
            <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${n < step ? 'border-accent bg-accent text-on-accent' : n === step ? 'border-accent' : 'border-white/25'}`}>
              {n < step ? '✓' : n}
            </span>
            {label}
          </li>
        ))}
      </ol>

      <section className="flex w-full max-w-[380px] flex-col gap-3">
        {step === 1 && (
          <>
            <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink-strong focus:outline-none">
              Er Tailscale på?
            </h2>
            <p className="m-0 text-sm text-soft">Vault når telefonen bare gjennom Tailscale, både hjemme og ute.</p>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-soft">
              <li>Åpne Tailscale-appen og slå den på.</li>
              <li>Logg inn med samme konto som på PC-en.</li>
              <li>PC-en må stå på, med Tailscale på.</li>
            </ul>
            <button type="button" onClick={() => setStep(2)} className={`${primary} mt-2`}>
              Tailscale er på
            </button>
          </>
        )}

        {step === 2 && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const s = normalizeServer(server);
              const bad = explainAddress(server, s);
              setHelp(bad);
              if (!bad) setStep(3);
            }}
          >
            <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink-strong focus:outline-none">
              Adressen til Vault
            </h2>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Adresse
              <input value={server} onChange={(e) => setServer(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="pc-navn.tailXXXX.ts.net" aria-describedby="gv-addr-hint" className={input} />
            </label>
            <p id="gv-addr-hint" className="m-0 text-[13px] text-soft">
              Står på PC-en under <b className="text-ink">Studio → Innstillinger → Tilgang</b> (Tailscale-adressen, med QR-kode). Den slutter vanligvis på .ts.net.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep(1)} className={ghost}>
                Tilbake
              </button>
              <button type="submit" className={primary}>
                Neste
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^\d{6,12}$/.test(pin)) return setHelp({ problem: 'wrong-pin', title: 'PIN-en er 6–12 sifre', help: ['Den samme som for Wi-Fi-modus på PC-en.'], step: 3 });
              setHelp(null);
              setStep(4);
              void runTest();
            }}
          >
            <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink-strong focus:outline-none">
              PIN
            </h2>
            <label className="flex flex-col gap-1 text-xs text-muted">
              PIN (6–12 sifre)
              <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" type="password" autoComplete="off" maxLength={12} aria-describedby="gv-pin-hint" className={`${input} tracking-[4px]`} />
            </label>
            <p id="gv-pin-hint" className="m-0 text-[13px] text-soft">
              Den samme som for Wi-Fi-modus. Den velges på PC-en under Studio → Innstillinger → Tilgang. PIN-en lagres ikke på telefonen.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep(2)} className={ghost}>
                Tilbake
              </button>
              <button type="submit" className={primary}>
                Test forbindelsen
              </button>
            </div>
          </form>
        )}

        {step === 4 && (
          <>
            <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink-strong focus:outline-none">
              Test forbindelsen
            </h2>
            <ul aria-live="polite" className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              <CheckRow state={checks.found} label="Finner Vault på adressen" />
              <CheckRow state={checks.pin} label="Sjekker PIN-en og kobler til" />
            </ul>
          </>
        )}

        {help && (
          <div role="alert" className="flex flex-col gap-1.5 rounded-xl border border-[#FF8A7A]/40 bg-[#FF8A7A]/[0.07] px-3 py-2.5">
            <p className="m-0 text-sm font-semibold text-[#FFB4A8]">{help.title}</p>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink">
              {help.help.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
        )}
        {step === 4 && help && (
          <div className="flex flex-wrap gap-2">
            {help.step < 4 && (
              <button
                type="button"
                onClick={() => {
                  setChecks({ found: null, pin: null });
                  setStep(help.step);
                }}
                className={ghost}
              >
                {help.step === 1 ? 'Sjekk Tailscale' : help.step === 2 ? 'Endre adressen' : 'Skriv PIN på nytt'}
              </button>
            )}
            {help.step !== 3 && (
              <button type="button" onClick={() => void runTest()} className={`${primary} !w-auto flex-1 px-5`}>
                Prøv igjen
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function CheckRow({ state, label }: { state: 'wait' | 'ok' | 'fail' | null; label: string }) {
  return (
    <li className={`flex items-center gap-2.5 ${state ? 'text-ink' : 'text-muted'}`}>
      <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${state === 'ok' ? 'border-accent bg-accent text-on-accent' : state === 'fail' ? 'border-[#FF8A7A] text-[#FF8A7A]' : 'border-white/25'}`}>
        {state === 'ok' ? '✓' : state === 'fail' ? '!' : state === 'wait' ? '…' : ''}
      </span>
      {label}
      <span className="sr-only">{state === 'ok' ? ' – ferdig' : state === 'fail' ? ' – feilet' : state === 'wait' ? ' – pågår' : ''}</span>
    </li>
  );
}

/** Appen får ikke kontakt (PC-en av, Tailscale av, eller enheten er trukket tilbake). */
export function UnreachableScreen({ error, onRetry, onReconnect }: { error: string; onRetry: () => void; onReconnect: () => void }) {
  const revoked = /^401 /.test(error);
  const status = Number(/^(\d{3}) /.exec(error)?.[1] ?? 0);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const h = !revoked && status ? explainHealth('https://x.ts.net', { kind: 'response', status, body: null }) : null;
  const title = revoked ? 'Enheten er ikke godkjent lenger' : offline ? 'Telefonen er uten nett' : h && h.problem !== 'not-vault' ? h.title : 'Får ikke kontakt med Vault på PC-en';
  const text = revoked
    ? ['Den er trukket tilbake på PC-en. Koble til på nytt med PIN-en.']
    : offline
      ? ['Slå på Wi-Fi eller mobildata, og prøv igjen.']
      : h && h.problem !== 'not-vault'
        ? h.help
        : ['Står PC-en på, og kjører Vault?', 'Er Tailscale på på telefonen?'];
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center bg-obsidian px-6 text-center text-ink">
      <Logo size={48} />
      <h1 className="mb-2 mt-8 text-lg font-semibold text-ink-strong">{title}</h1>
      <ul className="m-0 mb-6 flex max-w-[320px] list-none flex-col gap-1 p-0 text-sm text-muted">
        {text.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div className="flex gap-3">
        {!revoked && (
          <button type="button" onClick={onRetry} className="h-12 rounded-full bg-accent px-6 text-sm font-semibold text-on-accent">
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
