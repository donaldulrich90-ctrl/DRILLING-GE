/** Config dédiée à la génération du CSS Tailwind STATIQUE (hors-ligne) de
 *  plateforme-forage.html. Reprend les extensions de thème de la config
 *  inline du fichier HTML. Régénérer : voir scripts/build-offline-css.sh */
module.exports = {
  content: ['./plateforme-forage.html', './api-client.js', './i18n.js'],
  theme: {
    extend: {
      colors: {
        komatsu: {
          yellow: '#F5B800', gold: '#FFCE61', black: '#111827',
          blue: '#1e293b', surface: '#F4F5F7', success: '#28A745', danger: '#DC3545',
        }
      },
      fontFamily: { ged: ['"Barlow Semi Condensed"', 'Segoe UI', 'system-ui', 'sans-serif'] },
      boxShadow: {
        'ged-panel': '0 4px 14px rgba(28,28,28,0.08), 0 0 0 1px rgba(28,28,28,0.06)',
        'ged-modal': '0 25px 50px -12px rgba(0,0,0,0.45)',
      }
    }
  },
  plugins: []
};
