@echo off
chcp 936 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"

rem 更新知识库数据：默认读取 config\nwu.json，也可以通过参数指定配置文件
set CFG=%~1
if "%CFG%"=="" set CFG=config\nwu.json

echo [更新] %CFG%
if /I "%CFG%"=="config\nwu.json" (
  python tools\build_nwu_demo.py "%CFG%"
) else (
  python tools\build_data.py "%CFG%"
)
if errorlevel 1 goto :err

echo.
echo 知识库数据已写入 data\ 目录
echo 请重新启动教务问答系统以加载最新数据。
pause
goto :eof

:err
echo 数据更新失败，请检查上方错误信息。
pause
exit /b 1
