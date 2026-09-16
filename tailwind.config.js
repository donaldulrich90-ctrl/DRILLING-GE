/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        'komatsu-yellow': '#FFCD00',
        'komatsu-gold':   '#FFBE21',
        'komatsu-dark':   '#7A5800',
        'cat-yellow':     '#FFC72C',
        'cat-orange':     '#E05A20',
        'cat-black':      '#111111',
        'mine-bg':        '#EEF2F7',
        'mine-panel':     '#FFFFFF',
        'mine-card':      '#F7F9FC',
        'mine-card2':     '#E8EDF3',
        'mine-border':    '#D1D9E6',
        'mine-border-hi': '#94A3B8',
        'drill-green':    '#16A34A',
        'drill-amber':    '#D97706',
        'drill-red':      '#DC2626',
      },
    },
  },
  plugins: [],
}
