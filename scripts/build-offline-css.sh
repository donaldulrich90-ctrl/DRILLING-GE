#!/bin/sh
# Régénère le CSS Tailwind STATIQUE hébergé en local (public/vendor/tailwind.css)
# à partir des classes présentes dans plateforme-forage.html.
# À relancer après avoir ajouté de nouvelles classes Tailwind dans le HTML.
set -e
cd "$(dirname "$0")/.."
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/_tw_input.css
./node_modules/.bin/tailwindcss -c tailwind.offline.config.cjs -i /tmp/_tw_input.css -o public/vendor/tailwind.css --minify
echo "OK -> public/vendor/tailwind.css"
