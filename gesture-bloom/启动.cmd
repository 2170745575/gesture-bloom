@echo off
REM ============================================================
REM  Gesture Bloom - launcher
REM
REM  IMPORTANT: this .bat file must stay PURE ASCII.
REM  cmd.exe parses the whole file with the codepage that was
REM  active at launch, so any non-ASCII byte here shifts offsets
REM  and splits lines mid-character - which makes cmd try to
REM  execute fragments of Chinese comments as commands.
REM  All Chinese output is produced by _serve.ps1 / server.js
REM  (both are proper UTF-8), so we keep this file ASCII-only.
REM ============================================================

chcp 65001 >nul 2>nul
cd /d "%~dp0"
title Gesture Bloom

set "PORT=5173"
set "NODE_EXE="

call :try_node "node"
call :try_node "%ProgramFiles%\nodejs\node.exe"
call :try_node "%ProgramFiles(x86)%\nodejs\node.exe"
call :try_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"
call :try_node "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if defined NODE_EXE goto :run_node
goto :run_ps

:run_node
start "" "http://localhost:%PORT%/"
"%NODE_EXE%" server.js %PORT%
goto :done

:run_ps
start "" "http://localhost:%PORT%/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_serve.ps1" -Port %PORT%
goto :done

:done
echo.
echo   Server stopped.
pause
exit /b 0

REM ------------------------------------------------------------
REM  Helper: record the first usable node into NODE_EXE
REM ------------------------------------------------------------
:try_node
if defined NODE_EXE exit /b 0
set "CAND=%~1"
if "%CAND%"=="" exit /b 0

echo %CAND% | findstr /C:"\" >nul
if errorlevel 1 (
  for /f "delims=" %%P in ('where "%CAND%" 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%P"
  )
) else (
  if exist "%CAND%" set "NODE_EXE=%CAND%"
)
exit /b 0