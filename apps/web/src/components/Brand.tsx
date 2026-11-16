import { useState } from 'react';
import logo from '../assets/groovehouse-logo-round.png';
import { useSkin } from '../lib/skin';

/** Merkevarelogoer som er prøvd og ikke finnes ennå (så vi ikke spør serveren på nytt for hver visning). */
const missing = new Set<string>();

function GroovehouseLogo({ size, subtitle }: { size: number; subtitle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src={logo} alt="Groovehouse Records" width={size} height={size} className="block" />
      <div className="flex flex-col leading-none">
        <span className="font-display text-[15px] font-semibold tracking-[2px] text-gold">GROOVEHOUSE</span>
        <span className="mt-1 text-[9px] tracking-[4px] text-gold/80">{subtitle}</span>
      </div>
    </div>
  );
}

/**
 * Full logo-emblem. Del 19: skinnet kan vise et annet ordmerke (Echo Groove Nights → Echo Groove-ordmerket
 * fra assets/brand/echo-groove/). Finnes ikke fila ennå, vises Groovehouse-logoen. Ordmerket gjenskapes aldri med en font.
 */
export function Logo({ size = 40, subtitle = 'RECORDS' }: { size?: number; subtitle?: string }) {
  const brand = useSkin((s) => (s.skin.logo === 'groovehouse' ? null : s.skin.logo));
  const labels = useSkin((s) => s.skin.brand?.labels);
  const [, bump] = useState(0);
  if (!brand || missing.has(brand)) return <GroovehouseLogo size={size} subtitle={subtitle} />;
  return (
    <div className="flex flex-col items-start gap-1">
      <img
        src={`/api/brand/${brand}/logo`}
        alt="Echo Groove"
        height={size}
        style={{ height: size, width: 'auto', maxWidth: size * 4.2, filter: 'drop-shadow(0 0 calc(8px * var(--glow-k)) color-mix(in srgb, var(--accent) 55%, transparent))' }}
        className="block"
        onError={() => {
          missing.add(brand);
          bump((n) => n + 1);
        }}
      />
      {labels && <span className="gv-brand-label">{labels}</span>}
    </div>
  );
}

/** Echo Groove-motivet: hjerteslag-linja med hjerte. Brukes til favoritter, lasting og under «Spilles nå». */
export function Heartbeat({ width = 48, height = 16, animate = false, className = '' }: { width?: number; height?: number; animate?: boolean; className?: string }) {
  return (
    <svg width={width} height={height} viewBox="0 0 60 20" fill="none" aria-hidden="true" className={`${animate ? 'gv-heartbeat-anim' : ''} ${className}`} style={{ filter: 'drop-shadow(0 0 calc(4px * var(--glow-k)) var(--accent))' }}>
      <path d="M1 11h12l3-6 4 12 4-9 2 3h8" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M46.5 16.5s-7-4.2-7-8.6a3.6 3.6 0 0 1 7-1.3 3.6 3.6 0 0 1 7 1.3c0 4.4-7 8.6-7 8.6z" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** true når skinnet bruker hjerteslag-motivet (Echo Groove Nights). */
export const useHeartbeatMotif = () => useSkin((s) => s.skin.brand?.motif === 'heartbeat');
