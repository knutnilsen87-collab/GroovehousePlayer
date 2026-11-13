import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p
});

export const PlayIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />
  </svg>
);
export const PauseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);
export const PrevIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M19 20 9 12l10-8v16Z" />
    <path d="M5 19V5" />
  </svg>
);
export const NextIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m5 4 10 8-10 8V4Z" />
    <path d="M19 5v14" />
  </svg>
);
export const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
export const ShieldIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
  </svg>
);
export const DropsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);
export const ArchiveIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10h14V9" />
    <path d="M10 13h4" />
  </svg>
);
export const PulseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 12h3l3-8 4 16 3-8h5" />
  </svg>
);
export const UploadIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} strokeWidth={2.4}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);
export const LinkIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </svg>
);
/** Hopp til forrige/neste del (Intro, Drop, Break …) */
export const SectionPrevIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M11 17 6 12l5-5" />
    <path d="M18 17l-5-5 5-5" />
  </svg>
);
export const SectionNextIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m13 17 5-5-5-5" />
    <path d="m6 17 5-5-5-5" />
  </svg>
);
export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
export const StudioIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 21v-7" />
    <path d="M4 10V3" />
    <path d="M12 21v-9" />
    <path d="M12 8V3" />
    <path d="M20 21v-5" />
    <path d="M20 12V3" />
    <path d="M2 14h4" />
    <path d="M10 8h4" />
    <path d="M18 16h4" />
  </svg>
);
export const LibraryIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 4v16" />
    <path d="M9 4v16" />
    <path d="m14 4 6 16" />
  </svg>
);
export const ChevronDownIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const VolumeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </svg>
);
