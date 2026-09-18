@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Push GEDRILLING vers GitHub (DRILLING-GE)
echo ============================================
echo.

if exist ".git\index.lock" (
    echo [1/4] Suppression du verrou git restant...
    del /f /q ".git\index.lock"
) else (
    echo [1/4] Aucun verrou a supprimer.
)

echo [2/4] Ajout de tous les changements...
git add -A

echo [3/4] Commit...
git commit -m "feat(login): nouvelle page de connexion GEDRILLING + theme anthracite (visuel minier, i18n FR/EN, CSS)"

echo [4/4] Push vers origin/main...
git push

echo.
echo ============================================
echo   Termine. Verifie les messages ci-dessus.
echo ============================================
pause
