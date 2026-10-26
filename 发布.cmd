@echo off
REM ============================================================
REM  Gesture Bloom - publish to GitHub
REM
REM  IMPORTANT: this .bat file must stay PURE ASCII.
REM  cmd.exe parses the whole file with the codepage that was
REM  active at launch, so any non-ASCII byte here shifts offsets
REM  and makes cmd try to execute fragments of text as commands.
REM  All Chinese output comes from publish.ps1 (UTF-8 with BOM).
REM ============================================================

chcp 65001 >nul 2>nul
cd /d "%~dp0"
title Gesture Bloom - Publish

echo.
echo   ==========================================
echo     Gesture Bloom - Publish to GitHub
echo   ==========================================
echo.

set "GHUSER=2170745575"
set /p "INPUT=GitHub username [%GHUSER%]: "
if not "%INPUT%"=="" set "GHUSER=%INPUT%"

echo.
echo   User   : %GHUSER%
echo   Repo   : gesture-bloom
echo.
echo   Make sure you created an EMPTY repo named gesture-bloom at
echo   https://github.com/new  (do NOT add README / .gitignore / license)
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" -GitHubUser "%GHUSER%" -RepoName "gesture-bloom"

echo.
echo   Done. Press any key to close.
pause >nul