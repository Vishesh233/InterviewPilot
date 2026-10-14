/** @type {import('tailwindcss').Config} */
// Colors, radii and shadows come from the CSS variables in app/globals.css
// (the design tokens); this file only maps them to Tailwind names.
const token = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;
const scale = (name, steps) => Object.fromEntries(steps.map((step) => [step, token(`${name}-${step}`)]));

module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: token('surface'),
        subtle: token('subtle'),
        sunken: token('sunken'),
        ink: token('ink'),
        muted: token('muted'),
        faint: token('faint'),
        line: token('line'),
        'line-strong': token('line-strong'),
        brand: scale('brand', [50, 100, 200, 500, 600, 700, 800]),
        warning: scale('warning', [50, 200, 700]),
        danger: scale('danger', [50, 200, 500, 700]),
        info: scale('info', [50, 200, 700]),
      },
      borderRadius: {
        control: 'var(--radius-control)',
        card: 'var(--radius-card)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Georgia', 'ui-serif', 'serif'],
      },
    },
  },
  plugins: [],
};
