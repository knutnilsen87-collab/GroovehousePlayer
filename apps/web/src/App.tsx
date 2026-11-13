import { useEffect, useState } from 'react';
import { DropPage } from './pages/DropPage';
import { CommandCenter } from './pages/CommandCenter';
import { PlayerApp } from './pages/PlayerApp';

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
  const m = path.match(/^\/drop\/([a-z0-9-]+)\/?$/);
  if (m) return <DropPage dropSlug={m[1]!} recipient={new URLSearchParams(window.location.search).get('r')} />;
  if (path.startsWith('/studio')) return <CommandCenter />;
  return <PlayerApp />;
}
