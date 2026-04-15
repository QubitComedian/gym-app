import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        panel: '#141414',
        'panel-2': '#1c1c1c',
        border: '#242424',
        'border-strong': '#333333',
        muted: '#8a8a8a',
        'muted-2': '#b0b0b0',
        accent: '#d4ff3a',
        'accent-dim': '#2c3d10',
        'accent-soft': 'rgba(212,255,58,0.08)',
        danger: '#ff6b6b',
        ok: '#6bd47f',
        warn: '#f5c24e',
      },
      fontFamily: {
        sans: ['-apple-system', 'system-ui', '"SF Pro Text"', 'Inter', 'sans-serif'],
      },
      fontSize: {
        micro: ['11px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        tiny:  ['12px', { lineHeight: '1.45' }],
        small: ['13px', { lineHeight: '1.5' }],
        base:  ['15px', { lineHeight: '1.5' }],
        lg:    ['17px', { lineHeight: '1.4', letterSpacing: '-0.005em' }],
        xl:    ['22px', { lineHeight: '1.25', letterSpacing: '-0.01em' }],
        '2xl': ['28px', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        '3xl': ['34px', { lineHeight: '1.1',  letterSpacing: '-0.025em' }],
      },
      borderRadius: {
        sm: '8px',
        DEFAULT: '10px',
        md: '12px',
        lg: '14px',
        xl: '18px',
        '2xl': '22px',
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.02) inset',
        pop:  '0 12px 40px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
      },
    },
  },
  plugins: [],
};
export default config;
