@echo off
rem MixTouring 本地启动脚本：双击运行，自动起服务并打开浏览器
rem 关闭本窗口即停止服务
chcp 65001 > nul
cd /d "%~dp0server"
echo 正在启动 MixTouring 本地服务...
start "" http://localhost:3000/index.html
node --env-file-if-exists=.env index.mjs
pause
