@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found. Run the installer first.
  pause
  exit /b 1
)

if not exist "deepseek-harness-master\deepseek-harness-master\apps\cli\lib\bin.js" (
  echo ERROR: The bundled DSH runtime has not been built. Run the installer first.
  pause
  exit /b 1
)

echo 西北大学教务知识问答系统正在启动: http://127.0.0.1:3080/
echo 知识图谱: http://127.0.0.1:3080/nwu/knowledge-graph
echo Press Ctrl+C to stop.
echo.
node "tools\run_nwu.mjs" web
