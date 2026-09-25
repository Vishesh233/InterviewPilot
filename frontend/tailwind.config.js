/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: '#f7f8f4',
        ink: '#17201b',
        muted: '#6d766f',
        line: '#e4e9e2',
        brand: {
          50: '#eff8f0',
          100: '#d9efdc',
          500: '#2c8652',
          600: '#216b42',
          700: '#185536',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(23, 32, 27, 0.04), 0 8px 28px rgba(23, 32, 27, 0.035)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Georgia', 'ui-serif', 'serif'],
      },
    },
  },
  plugins: [],
};