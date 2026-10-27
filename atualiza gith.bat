@echo off
chcp 65001 >nul
color 0E
echo ===================================================
echo    🔧 REPARAR E FORCAR ENVIO PARA O GITHUB
echo ===================================================
echo.

echo [1/4] A preparar ficheiros...
git add .

echo [2/4] A criar versao de seguranca...
git commit -m "Forcando atualizacao do repositorio"

echo [3/4] A garantir que a ramificacao principal e a 'main'...
git branch -M main

echo [4/4] A enviar (forcar) os ficheiros para o GitHub...
git push -u origin main --force

echo.
echo ===================================================
echo   ✅ ENVIO FORCADO CONCLUIDO!
echo   O seu Vercel vai ser reconstruido agora mesmo.
echo ===================================================
pause