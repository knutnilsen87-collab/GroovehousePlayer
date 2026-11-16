/** @type {import('tailwindcss').Config} */
// Del 14 «High-End Studio»: coveret styrer alle aksenter (CSS-variabler fra assets.palette), gull bare i logoen.
const fromVar = (v) => `color-mix(in srgb, var(${v}) calc(<alpha-value> * 100%), transparent)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Del 19: flatene følger skinnet (CSS-variabler fra skinRootVars), med støtte for /alfa.
        obsidian: fromVar('--c-obsidian'),
        surface: fromVar('--c-surface'),
        sunken: fromVar('--c-sunken'),
        ink: '#E9ECF2',
        'ink-strong': '#F5F7FA',
        muted: '#A3ACBA',
        /** Sekundær tekst og ikoner (økt kontrast for mørke studio-/klubbomgivelser). */
        soft: '#C6CDD9',
        /** Bare til logoen (Brand.tsx). En test passer på at gull ikke brukes andre steder. */
        gold: { hi: '#F0DC6A', DEFAULT: '#F0C030', deep: '#B06000' },
        // Aksentfargene kommer ALLTID fra coverets palett via CSS-variabler, med støtte for /alfa.
        accent: fromVar('--accent'),
        'accent-2': fromVar('--accent-2'),
        'on-accent': 'var(--on-accent)'
      },
      fontFamily: {
        // Del 22: Clash Display (via --font-display, skin kan overstyre), Inter, Geist Mono og Syncopate til etiketter
        display: ['var(--font-display)'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
        label: ['Syncopate', 'Inter', 'sans-serif']
      },
      backgroundImage: {
        gold: 'linear-gradient(135deg, #F0DC6A 0%, #F0C030 45%, #B06000 100%)'
      },
      borderRadius: {
        panel: 'var(--panel-radius)'
      }
    }
  },
  plugins: []
};
