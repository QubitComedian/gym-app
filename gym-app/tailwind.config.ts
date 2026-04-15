import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        panel: '#161616',
        'panel-2': '#1f1f1f',
        border: '#2a2a2a',
        muted: '#8a8a8a',
        accent: '#d4ff3a',
        'accent-dim': '#334a0f',
        danger: '#ff5a5a',
        ok: '#4ade80',
      },
      fontFamily: {
        sans: ['-apple-system', 'system-ui', '"SF Pro Text"', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
