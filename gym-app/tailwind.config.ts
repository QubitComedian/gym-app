import type { Config } from 'tailwindcss';

/**
 * Design tokens — v2.
 *
 * We keep backward-compatible aliases (panel, panel-2, accent, etc.) so
 * existing components keep rendering while we redesign. New components
 * should prefer the more descriptive semantic tokens under `surface`,
 * `ink`, `line`, and `brand`.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ─── Core surfaces ──────────────────────────────────────────────
        bg: '#08090b',              // app background (deeper, slightly blue-black)
        'bg-raised': '#0e1013',     // elevated section background
        panel: '#14161a',           // default card
        'panel-2': '#1c1f24',       // raised card
        'panel-3': '#242830',       // hovered card / well

        // ─── Lines / borders ────────────────────────────────────────────
        border: '#23272e',
        'border-strong': '#343944',
        'border-accent': 'rgba(212,255,58,0.32)',

        // ─── Ink (text) ─────────────────────────────────────────────────
        ink: '#f6f7f8',
        'ink-2': '#cfd2d7',
        muted: '#8a8f97',
        'muted-2': '#b4b8bf',

        // ─── Brand accent (electric lime) ───────────────────────────────
        accent: '#d4ff3a',
        'accent-2': '#aef03b',       // deeper companion for gradients
        'accent-dim': '#2c3d10',
        'accent-soft': 'rgba(212,255,58,0.10)',
        'accent-glow': 'rgba(212,255,58,0.45)',

        // ─── Secondary hues used sparingly ──────────────────────────────
        iris: '#8f9bff',             // cool secondary for info / AI chat
        'iris-soft': 'rgba(143,155,255,0.12)',
        coral: '#ff8b6b',            // warm secondary for weight / body metrics
        'coral-soft': 'rgba(255,139,107,0.12)',

        // ─── Feedback ───────────────────────────────────────────────────
        ok: '#6bd47f',
        'ok-soft': 'rgba(107,212,127,0.14)',
        warn: '#f5c24e',
        'warn-soft': 'rgba(245,194,78,0.14)',
        danger: '#ff6b6b',
        'danger-soft': 'rgba(255,107,107,0.14)',
      },
      fontFamily: {
        sans: ['-apple-system', 'system-ui', '"SF Pro Text"', 'Inter', 'sans-serif'],
        display: ['-apple-system', 'system-ui', '"SF Pro Display"', 'Inter', 'sans-serif'],
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
        '4xl': ['44px', { lineHeight: '1.05', letterSpacing: '-0.03em' }],
      },
      borderRadius: {
        sm: '8px',
        DEFAULT: '10px',
        md: '12px',
        lg: '14px',
        xl: '18px',
        '2xl': '22px',
        '3xl': '28px',
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.03) inset, 0 1px 2px rgba(0,0,0,0.25)',
        'card-lg': '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
        pop:  '0 18px 60px -20px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.04)',
        glow: '0 0 40px -8px rgba(212,255,58,0.35)',
        'glow-sm': '0 0 18px -6px rgba(212,255,58,0.4)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #d4ff3a 0%, #aef03b 45%, #8ad728 100%)',
        'iris-gradient': 'linear-gradient(135deg, #8f9bff 0%, #6a75e0 100%)',
        'coral-gradient': 'linear-gradient(135deg, #ffb87e 0%, #ff8b6b 100%)',
        'panel-gradient': 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 45%)',
        'hero-gradient': 'radial-gradient(120% 80% at 20% 0%, rgba(212,255,58,0.12) 0%, rgba(212,255,58,0) 60%)',
      },
      transitionTimingFunction: {
        'swift': 'cubic-bezier(0.2, 0.85, 0.35, 1)',
      },
      animation: {
        'pulse-accent': 'pulseAccent 2.6s ease-in-out infinite',
        'shimmer': 'shimmer 2.4s linear infinite',
      },
      keyframes: {
        pulseAccent: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(212,255,58,0.35)' },
          '50%': { boxShadow: '0 0 0 8px rgba(212,255,58,0.0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
export default config;
