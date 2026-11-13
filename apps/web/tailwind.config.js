/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#07080B',
        surface: '#0E1015',
        sunken: '#0A0B0F',
        ink: '#EDEAE2',
        'ink-strong': '#F4F1EA',
        muted: '#A39E91',
        champagne: '#C9B98E',
        gold: { hi: '#F0DC6A', DEFAULT: '#F0C030', deep: '#B06000' },
        // Aksentfargene kommer ALLTID fra coverets palett via CSS-variabler.
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        'on-accent': 'var(--on-accent)'
      },
      fontFamily: {
        display: ['Oswald', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif']
      },
      backgroundImage: {
        gold: 'linear-gradient(135deg, #F0DC6A 0%, #F0C030 45%, #B06000 100%)'
      }
    }
  },
  plugins: []
};
