/**
 * Del 27 pkt. 3: hva gikk galt da telefonen skulle koble til Vault, og hva gjør du med det?
 * Rene funksjoner (testes uten nett). PIN-en er aldri med i noe av dette.
 */
export type ConnectProblem =
  | 'offline'
  | 'bad-address'
  | 'unreachable'
  | 'vault-down'
  | 'misdirected'
  | 'forbidden'
  | 'not-vault'
  | 'wrong-pin'
  | 'rate-limited'
  | 'no-pin'
  | 'interrupted'
  | 'other';

export interface ConnectHelp {
  problem: ConnectProblem;
  title: string;
  help: string[];
  /** Hvilket steg det lønner seg å gå tilbake til. */
  step: 1 | 2 | 3 | 4;
}

/** Resultatet av å spørre /api/health (steg 4, første del). */
export type HealthOutcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'network-error'; online: boolean; timedOut: boolean };

const looksLikeTailscale = (server: string) => /\.ts\.net$/i.test(new URL(server).hostname);

export function explainHealth(server: string, h: HealthOutcome): ConnectHelp | null {
  if (h.kind === 'network-error') {
    if (!h.online) return OFFLINE;
    const help = [
      'Er Tailscale på på telefonen, og logget inn med samme konto som PC-en?',
      'Står PC-en på, med Tailscale på?',
      looksLikeTailscale(server) ? 'Stemmer adressen? Sammenlign med Studio → Innstillinger → Tilgang på PC-en.' : 'Adressen ser ikke ut som en Tailscale-adresse (den slutter vanligvis på .ts.net). Sjekk den i Studio → Innstillinger → Tilgang på PC-en.'
    ];
    return { problem: 'unreachable', title: h.timedOut ? 'Vault svarer ikke' : 'Får ikke kontakt med Vault', help, step: looksLikeTailscale(server) ? 1 : 2 };
  }
  const { status, body } = h;
  if (status === 421)
    return {
      problem: 'misdirected',
      title: 'Adressen er ikke godkjent i Vault (421)',
      help: ['Vault svarer bare på adressene som er slått på for fjerntilgang.', 'På PC-en: Studio → Innstillinger → Tilgang viser Tailscale-adressen som er slått på. Bruk den.'],
      step: 2
    };
  if (status === 502 || status === 503 || status === 504)
    return { problem: 'vault-down', title: 'PC-en svarer, men Vault kjører ikke', help: ['Start Groovehouse Vault på PC-en (snarveien på skrivebordet), og prøv igjen.'], step: 4 };
  if (status === 403)
    return { problem: 'forbidden', title: 'Vault slapp ikke inn forbindelsen', help: ['Telefonen må gå via Tailscale, ikke vanlig internett. Slå på Tailscale på telefonen og prøv igjen.'], step: 1 };
  if (status >= 200 && status < 300) {
    const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : undefined;
    if (app === 'groovehouse-vault') return null;
  }
  return { problem: 'not-vault', title: 'Adressen svarer, men det er ikke Vault', help: ['Sjekk at du har skrevet PC-ens Tailscale-adresse (Studio → Innstillinger → Tilgang på PC-en).'], step: 2 };
}

/** Resultatet av paringen (steg 4, andre del). */
export type PairOutcome = { kind: 'response'; status: number; error?: string } | { kind: 'network-error'; online: boolean };

export function explainPair(p: PairOutcome): ConnectHelp {
  if (p.kind === 'network-error') return p.online ? { problem: 'interrupted', title: 'Forbindelsen ble brutt', help: ['Nettet falt ut underveis. Prøv igjen.'], step: 4 } : OFFLINE;
  if (p.status === 401) return { problem: 'wrong-pin', title: 'Feil PIN', help: ['Skriv PIN-en på nytt. Den er 6–12 sifre, den samme som for Wi-Fi-modus.', 'Etter flere feil forsøk må du vente noen minutter.'], step: 3 };
  if (p.status === 429) return { problem: 'rate-limited', title: 'For mange forsøk', help: [p.error ?? 'Vent litt og prøv igjen.'], step: 3 };
  if (p.status === 409) return { problem: 'no-pin', title: 'Ingen PIN er valgt på PC-en', help: ['Velg en PIN på PC-en under Studio → Innstillinger → Tilgang, og prøv igjen.'], step: 3 };
  const h = explainHealth('https://x.ts.net', { kind: 'response', status: p.status, body: null });
  if (h && h.problem !== 'not-vault') return h;
  return { problem: 'other', title: `Noe gikk galt (${p.status})`, help: [p.error ?? 'Prøv igjen om litt.'], step: 4 };
}

const OFFLINE: ConnectHelp = { problem: 'offline', title: 'Telefonen er uten nett', help: ['Slå på Wi-Fi eller mobildata, og prøv igjen.'], step: 4 };

export function explainAddress(input: string, normalized: string | null): ConnectHelp | null {
  if (normalized) return null;
  const s = input.trim();
  if (!s) return { problem: 'bad-address', title: 'Skriv adressen', help: ['Den står på PC-en under Studio → Innstillinger → Tilgang, f.eks. pc-navn.tailXXXX.ts.net.'], step: 2 };
  if (/^http:\/\//i.test(s)) return { problem: 'bad-address', title: 'Adressen må være HTTPS', help: ['Bruk Tailscale-adressen (https://…ts.net), ikke Wi-Fi-adressen med http.'], step: 2 };
  return { problem: 'bad-address', title: 'Det ser ikke ut som en adresse', help: ['Skriv vertsnavnet uten mellomrom, f.eks. pc-navn.tailXXXX.ts.net.'], step: 2 };
}
