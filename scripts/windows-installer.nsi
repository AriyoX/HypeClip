Unicode true
Name "HypeClip"
OutFile "${INSTALLER_FILE}"
InstallDir "$LOCALAPPDATA\Programs\HypeClip"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\HypeClip"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "HypeClip"
VIAddVersionKey "FileDescription" "HypeClip Windows Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define MUI_WELCOMEPAGE_TEXT "Install HypeClip for this Windows account. Close HypeClip first if you are updating it."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "Open HypeClip and follow Setup in your browser to install the tools and models."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open HypeClip"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenStudio
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "HypeClip requires Windows x64." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "HypeClip"
  SetShellVarContext current
  SetOutPath "$INSTDIR\app"
  File /r "${APP_FILES}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\HypeClip"
  CreateShortcut "$SMPROGRAMS\HypeClip\HypeClip.lnk" "$INSTDIR\app\Start HypeClip.cmd"
  CreateShortcut "$SMPROGRAMS\HypeClip\Quick Start.lnk" "$INSTDIR\app\Start Here.html"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "HypeClip"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function OpenStudio
  ExecShell "open" "$INSTDIR\app\Start HypeClip.cmd"
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\HypeClip\HypeClip.lnk"
  Delete "$SMPROGRAMS\HypeClip\Quick Start.lnk"
  RMDir "$SMPROGRAMS\HypeClip"
  RMDir /r "$INSTDIR\app\node_modules"
  RMDir /r "$INSTDIR\app\.venv"
  !include "${APP_CLEANUP}"
  RMDir "$INSTDIR\app"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
