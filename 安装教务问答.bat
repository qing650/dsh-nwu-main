@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js 24 or Node.js 22.19+ is required.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  corepack pnpm --version >nul 2>nul
  if errorlevel 1 (
    echo ERROR: pnpm was not found. Run: npm install -g pnpm
    pause
    exit /b 1
  )
  set "PNPM_RUNNER=corepack pnpm"
) else (
  set "PNPM_RUNNER=pnpm"
)

py -3.11 --version >nul 2>nul
if errorlevel 1 (
  python -c "import sys;v=sys.version_info;sys.exit(0 if v[0]==3 and v[1]==11 else 1)" >nul 2>nul
  if errorlevel 1 (
    echo ERROR: Python 3.11 is required for document, audio and GIS extraction. Activate the conda environment dsh-nwu or install Python 3.11 with the Windows launcher.
    pause
    exit /b 1
  )
  set "PY_CMD=python"
  set "PY_ARGS="
) else (
  set "PY_CMD=py"
  set "PY_ARGS=-3.11"
)

echo [1/4] Installing and building the bundled DSH runtime...
pushd "deepseek-harness-master\deepseek-harness-master"
call %PNPM_RUNNER% install --frozen-lockfile
if errorlevel 1 (popd & goto :failed)
call %PNPM_RUNNER% build
if errorlevel 1 (popd & goto :failed)
popd

echo [2/4] Installing the bundled knowledge graph component...
pushd "dsh-nwu-intake"
call npm ci --omit=dev --legacy-peer-deps
if errorlevel 1 (popd & goto :failed)
popd

echo [3/4] Installing document, audio and GIS extraction dependencies...
%PY_CMD% %PY_ARGS% -m pip install -r requirements-ingest.txt
if errorlevel 1 goto :failed

echo [4/4] Validating the NWU configuration...
node "tools\run_nwu.mjs" web --dump-config >nul
if errorlevel 1 goto :failed

echo.
echo Installation completed. Run the startup batch file to open 西北大学教务知识问答系统.
pause
exit /b 0

:failed
echo.
echo ERROR: Installation or configuration validation failed. Keep the log above.
pause
exit /b 1
