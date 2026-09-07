import type { Config } from 'tailwindcss';

/**
 * Tailwind is set up for the NEW React surfaces you build (login, and future
 * dashboards/components as you migrate the legacy UI). The legacy app keeps its
 * own hand-written CSS untouched. The palette mirrors the app's lime accent so
 * new screens feel native.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: '#a8f931', 2: '#bdfb63', soft: '#eefccb', ink: '#4d7a0a' },
        ink: { DEFAULT: '#1d1d1f', 2: '#424245' },
      },
      fontFamily: {
        sans: ['"SF Pro Display"', '"Anuphan"', '"IBM Plex Sans Thai"', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '20px', '2xl': '30px' },
    },
  },
  plugins: [],
};
export default config;
