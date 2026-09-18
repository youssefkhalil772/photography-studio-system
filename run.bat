@echo off
chcp 65001 >nul
cd /d "e:\photography studio system\EL_Tarezy-v2.2.4"
call npm.cmd start
if errorlevel 1 pause
