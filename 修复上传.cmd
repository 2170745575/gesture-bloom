@echo off
REM ============================================================
REM  Gesture Bloom - FIX a bad upload (one time only)
REM
REM  Use this if you previously used GitHub's web "Upload files"
REM  and dragged the FOLDER in. That puts the project inside a
REM  subdirectory AND silently skips hidden files (.nojekyll),
REM  so GitHub Pages shows a blank page.
REM
REM  This script pushes the correct structure (all files at the
REM  repo ROOT) and OVERWRITES the remote. Nothing is lost: the
REM  local commit already contains every file.
REM
REM  IMPORTANT: this .bat file must stay PURE ASCII.
REM  cmd.exe parses the file with the codepage active at launch,
REM  so non-ASCII bytes here shift offsets and cmd tries to
REM  execute fragments of text as commands.
REM ============================================================

chcp 65001 >nul 2>nul
cd /d "%~dp0"
title Gesture Bloom - Fix bad upload

echo.
echo   ==========================================================
echo     Fix a previous bad upload
echo   ==========================================================
echo.
echo   This will OVERWRITE the remote repo content with the
echo   correct structure (files at the repo root instead of
echo   inside a "gesture-bloom/" subdirectory).
echo.
echo   Remote : https://github.com/2170745575/gesture-bloom
echo   Local  : %~dp0
echo.
echo   Nothing is lost - the local commit has all 55 files.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" -GitHubUser "2170745575" -RepoName "gesture-bloom" -Force

echo.
echo   ----------------------------------------------------------
echo   After the push succeeds, wait ~1 minute then open:
echo     https://2170745575.github.io/gesture-bloom/
echo.
echo   If it is still blank, check Pages settings:
echo     https://github.com/2170745575/gesture-bloom/settings/pages
echo     Source = Deploy from a branch
echo     Branch = main   Folder = / (root)
echo   ----------------------------------------------------------
echo.
pause