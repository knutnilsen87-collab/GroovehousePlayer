import { useEffect, useState } from 'react';
import { DropPage } from './pages/DropPage';
import { CommandCenter } from './pages/CommandCenter';
import { ConnectScreen } from './pages/Connect';
import { PlayerApp } from './pages/PlayerApp';
import { isApp, loadConnection } from './lib/platform';
import { startUpdater } from './lib/updater';
import { UpdateBanner } from './components/UpdateBanner';
import { applySkin, BUILT_IN_SKINS, useSkin } from './lib/skin';

/** Minimal ruter: / er din spiller, /studio er Command Center, /drop/<slug> er lyttersiden. */
function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function App() {
  const path = useRoute();
  // Android-appen: tilkoblingen leses fra Keystore før noe annet. Web: alltid klar.
  const [conn, setConn] = useState<'loading' | 'ok' | 'none'>(isApp ? 'loading' : 'ok');
  useEffect(() => {
    if (isApp)
      void loadConnection().then((ok) => {
        setConn(ok ? 'ok' : 'none');
        // Del 15: meld «klar» (ellers rulles en ny bunt tilbake) og se etter oppdateringer
        void startUpdater();
      });
  }, []);
  // Del 19: egne skins og «samme på alle enheter» hentes fra Vault når vi er tilkoblet
  useEffect(() => {
    if (conn === 'ok' && !path.startsWith('/drop/')) void useSkin.getState().load();
  }, [conn, path]);
  if (conn === 'loading') return <main className="min-h-[100svh] bg-obsidian" />;
  if (conn === 'none') return <ConnectScreen onConnected={() => setConn('ok')} />;
  const m = path.match(/^\/drop\/([a-z0-9-]+)\/?$/);
  // Lyttersiden følger alltid coveret (del 19 pkt. 7), uansett skin på enheten
  if (m && !isApp) {
    applySkin(BUILT_IN_SKINS[0]!);
  }
  if (m && !isApp) return <DropPage dropSlug={m[1]!} recipient={new URLSearchParams(window.location.search).get('r')} />;
  if (path.startsWith('/studio')) return <CommandCenter />;
  return (
    <>
      {isApp && <UpdateBanner />}
      <PlayerApp onDisconnected={() => setConn('none')} />
    </>
  );
}
