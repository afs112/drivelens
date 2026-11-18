@echo off
cd /d "%~dp0"
echo ==================================================
echo   DriveLens Gallery - http://localhost:5173
echo   Keep this window open while using DriveLens.
echo   Press Ctrl+C to stop the server.
echo ==================================================
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" serve.py 5173 --open %*
) else (
    python serve.py 5173 --open %*
)
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start server. Please check Python 3 installation.
    pause
)
