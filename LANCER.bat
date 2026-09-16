@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   GOOD ENGINEERS-DRILL
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo Installez Node.js LTS : https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installation des dependances npm...
    call npm install
    if errorlevel 1 (
        echo Echec npm install
        pause
        exit /b 1
    )
)

if not exist "database.db" (
    echo Initialisation de la base SQLite...
    call npm run init-db
    if errorlevel 1 (
        echo Echec init-db
        pause
        exit /b 1
    )
)

echo.
set PORT=3000
echo Serveur pret. Ouvrez dans le navigateur :
echo   http://localhost:3000
echo.
echo Comptes par defaut localement : admin / admin  ^(changez en production^)
echo Fermez cette fenetre pour arreter le serveur.
echo.

node server.js
pause
