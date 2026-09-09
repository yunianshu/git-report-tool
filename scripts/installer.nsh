; electron-builder NSIS custom hook (ASCII only: NSIS include encoding is fragile)
;
; 1.4.35 and earlier shipped the bundled Harness runtime as ~26k loose files under
; resources\harness-runtime, which made the installer take ~16 minutes (extract +
; copy every file). Newer versions ship resources\harness-runtime.tar.gz instead
; and unpack it on first launch. Remove the legacy loose directory on upgrade so
; it does not linger (and does not shadow the archive).
!macro customInstall
  RMDir /r "$INSTDIR\resources\harness-runtime"
!macroend
