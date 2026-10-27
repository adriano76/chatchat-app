@echo off
chcp 65001 >nul
color 0A
echo ===================================================
echo    🚀 ATUALIZANDO O SITE (GITHUB + VERCEL)
echo ===================================================
echo.
set /p MSG="O que voce alterou hoje? (ex: mudei o icone): "
if "%MSG%"=="" set MSG="Atualizacao do ChatChat/Repot"

echo.
echo [1/3] A preparar os ficheiros alterados...
git add .

echo.
echo [2/3] A salvar a versao...
git commit -m "%MSG%"

echo.
echo [3/3] A enviar para as nuvens (GitHub)...
git push -u origin main

echo.
echo ===================================================
echo   ✅ PRONTO! O Vercel ja esta a atualizar o site.
echo   Demora cerca de 1 a 2 minutos para ficar online.
echo ===================================================
pause