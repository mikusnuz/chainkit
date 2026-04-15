/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
      colors: {
        surface: {
          0: '#0a0a0a',
          50: '#111111',
          100: '#1a1a1a',
          200: '#222222',
          300: '#2a2a2a',
        },
      },
    },
  },
  plugins: [],
}
