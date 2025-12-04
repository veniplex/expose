import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],

  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'sans-serif'],
      },
      colors: {
        glass: {
          100: 'rgba(255, 255, 255, 0.1)',
          200: 'rgba(255, 255, 255, 0.2)',
          300: 'rgba(255, 255, 255, 0.3)',
          border: 'rgba(255, 255, 255, 0.2)',
        },
        dark: {
          bg: '#0f172a',
          surface: '#1e293b',
        },
        brand: {
          primary: '#3b82f6',
          secondary: '#8b5cf6',
          accent: '#f472b6',
        }
      }
    }
  },

  plugins: [typography, forms]
};
