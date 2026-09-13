@echo off
setlocal
rem Builds bin\audio-capture.exe with MSVC. Needs "Desktop development with C++" (MSVC + Windows SDK).

set "HERE=%~dp0"
set "OUT=%HERE%..\..\bin"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"

if not exist "%VSWHERE%" (
  echo vswhere.exe not found. Install Visual Studio Build Tools with the C++ workload.
  exit /b 1
)

for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo No Visual Studio install with the MSVC x64 tools was found.
  echo Add the "Desktop development with C++" workload in the Visual Studio Installer.
  exit /b 1
)

rem vcvars looks vswhere up on PATH.
set "PATH=%PATH%;%ProgramFiles(x86)%\Microsoft Visual Studio\Installer"
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist "%OUT%" mkdir "%OUT%"

pushd "%HERE%"
cl /nologo /std:c++17 /O2 /MT /EHsc /W3 /DUNICODE /D_UNICODE main.cpp ^
   /Fo"%TEMP%\audio-capture.obj" /Fe"%OUT%\audio-capture.exe" ^
   /link ole32.lib mmdevapi.lib user32.lib
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" exit /b %RC%
echo Built %OUT%\audio-capture.exe
