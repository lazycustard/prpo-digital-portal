@echo off
cd /d "%~dp0"
echo Starting Procurement Portal backend...
start "Procurement Backend" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3001/pr_portal.html"
