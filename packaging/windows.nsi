Unicode True
!include "MUI2.nsh"
Name "PaperLens"
Icon "icon.ico"
UninstallIcon "icon.ico"
OutFile "../build/windows/PaperLens-Setup-0.5.18.exe"
InstallDir "$LOCALAPPDATA\PaperLens"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
Section "PaperLens" SEC01
 SetOutPath "$INSTDIR"
 File "../build/windows/PaperLens.exe"
 CreateDirectory "$SMPROGRAMS\PaperLens"
 CreateShortcut "$SMPROGRAMS\PaperLens\PaperLens.lnk" "$INSTDIR\PaperLens.exe"
 CreateShortcut "$DESKTOP\PaperLens.lnk" "$INSTDIR\PaperLens.exe"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens" "DisplayName" "PaperLens"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens" "DisplayVersion" "0.5.18"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
 Delete "$INSTDIR\PaperLens.exe"
 Delete "$INSTDIR\Uninstall.exe"
 Delete "$DESKTOP\PaperLens.lnk"
 Delete "$SMPROGRAMS\PaperLens\PaperLens.lnk"
 RMDir "$SMPROGRAMS\PaperLens"
 RMDir "$INSTDIR"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens"
SectionEnd
