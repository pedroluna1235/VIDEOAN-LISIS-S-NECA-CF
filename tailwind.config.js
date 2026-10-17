/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        seneca: {
          red: '#cc2016',
          darkred: '#a81810',
          yellow: '#f5b800',
          dark: '#141414',
          header: '#191919',
          tab: '#242424',
          blue: '#1666c0',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        condensed: ['"Barlow Condensed"', '"Roboto Condensed"', 'Inter', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
