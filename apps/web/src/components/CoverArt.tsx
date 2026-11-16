import type { Palette } from '@gv/shared/web';

/** Viser coveret, eller et subtilt, mørkt studio-ikon når asset mangler cover (slik at aksentfargen forbeholdes aktive elementer). */
export function CoverArt({ src, title, size, rounded = 14, fluid = false, draft = false }: { src: string | null; palette: Palette; title: string; size: number; rounded?: number; /** Fyll bredden (kvadratisk), del 14-kortet. */ fluid?: boolean; /** Del 16: utkast får stiplet kant. */ draft?: boolean }) {
  const dims = { ...(fluid ? { width: '100%', height: 'auto', aspectRatio: '1 / 1' } : { width: size, height: size }), ...(draft ? { outline: '1.5px dashed rgba(255,255,255,0.55)', outlineOffset: size > 80 ? 3 : 1 } : {}) };
  if (src) {
    return (
      <img
        src={src}
        alt={`Cover: ${title}`}
        width={size}
        height={size}
        className="block object-cover shadow-[0_30px_60px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.06]"
        style={{ ...dims, borderRadius: rounded }}
      />
    );
  }
  const iconSize = Math.max(14, Math.min(36, Math.round(size * 0.34)));
  return (
    <div
      role="img"
      aria-label={`Cover mangler: ${title}`}
      className="relative flex items-center justify-center overflow-hidden ring-1 ring-white/[0.07]"
      style={{
        ...dims,
        borderRadius: rounded,
        background: `repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,0.025) 0 1px, transparent 2px 6px), radial-gradient(circle at 50% 35%, #161A24 0%, #0B0D12 75%)`
      }}
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center rounded-full border border-white/[0.08] bg-[#121620] text-white/30 shadow-inner"
        style={{
          width: Math.max(20, Math.round(size * 0.44)),
          height: Math.max(20, Math.round(size * 0.44))
        }}
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" strokeOpacity="0.45" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" fillOpacity="0.35" />
        </svg>
      </span>
    </div>
  );
}
