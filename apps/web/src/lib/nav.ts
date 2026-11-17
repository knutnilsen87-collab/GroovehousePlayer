/**
 * Del 27 pkt. 5: navigasjon uten å laste siden på nytt, så avspillingen aldri stopper når du bytter mellom
 * spilleren og Studio. Tilbake/Frem i nettleseren virker fordi alt går gjennom historikken.
 */
export function go(url: string, opts: { replace?: boolean } = {}) {
  if (typeof window === 'undefined') return;
  const u = new URL(url, window.location.href);
  if (u.origin !== window.location.origin) {
    window.location.href = url;
    return;
  }
  const next = u.pathname + u.search + u.hash;
  const cur = window.location.pathname + window.location.search + window.location.hash;
  if (next === cur) return;
  if (opts.replace) history.replaceState(history.state, '', next);
  else history.pushState({ gv: true }, '', next);
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}

/** For <a href>: vanlig klikk navigerer i appen, Ctrl/Cmd/midtklikk åpner som før (ny fane). */
export function linkClick(e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void; currentTarget: { getAttribute: (n: string) => string | null } }) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute('href');
  if (!href) return;
  e.preventDefault();
  go(href);
}
