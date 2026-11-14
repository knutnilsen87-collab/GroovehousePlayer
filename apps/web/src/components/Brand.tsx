import logo from '../assets/groovehouse-logo-round.png';

/** Full logo-emblem. I små størrelser (< 32 px) bør det forenklede merket brukes når det finnes som SVG. */
export function Logo({ size = 40, subtitle = 'RECORDS' }: { size?: number; subtitle?: string }) {
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
