@echo off
setlocal
cd /d %~dp0

echo Removing old runtime state from this test project...
if exist workspace rmdir /s /q workspace
if exist tile_cache rmdir /s /q tile_cache
if exist cache\metadata rmdir /s /q cache\metadata

mkdir workspace
mkdir workspace\coverage
mkdir workspace\logs
mkdir tile_cache
mkdir cache
mkdir cache\metadata

echo Done. The source code and dbRoot files were kept.
endlocal
