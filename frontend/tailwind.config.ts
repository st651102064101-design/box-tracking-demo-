import type { Config } from 'tailwindcss';

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
