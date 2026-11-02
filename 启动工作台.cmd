@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先从 https://nodejs.org/ 安装 Node.js 24.2 或更高版本，再双击此文件。
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>24||(v[0]===24&&v[1]>=2)?0:1)"
if errorlevel 1 (
  echo 当前 Node.js 版本过低，需要 24.2 或更高版本。
  pause
  exit /b 1
)
node "%~dp0workbench\app\start.cjs"
if errorlevel 1 pause
