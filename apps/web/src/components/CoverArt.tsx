import type { Palette } from '@gv/shared/web';

/** Viser coveret, eller et rolig vinyl-motiv i palettens farger når asset mangler cover. */
export function CoverArt({ src, palette, title, size, rounded = 14 }: { src: string | null; palette: Palette; title: string; size: number; rounded?: number }) {
  if (src) {
    return (
      <img
        src={src}
        alt={`Cover: ${title}`}
        width={size}
        height={size}
        className="block object-cover shadow-[0_30px_60px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.06]"
        style={{ width: size, height: size, borderRadius: rounded }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={`Cover mangler: ${title}`}
      className="relative overflow-hidden ring-1 ring-white/[0.06]"
      style={{
        width: size,
        height: size,
        borderRadius: rounded,
        background: `repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,0.05) 0 1px, transparent 2px 6px), #0B0D12`
      }}
    >
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: size * 0.28,
          height: size * 0.28,
          background: `radial-gradient(circle, ${palette.primary} 0 18%, ${palette.secondary} 19% 100%)`
        }}
      />
    </div>
  );
}
