; Uninstalling Ringkeeper Connect puts the AI apps' settings back the way they
; were before it (Claude Desktop, Cursor, Claude Code), so they keep working.
;
; This uninstaller also runs during every automatic update (to remove the old
; version's files). Restoring then would silently disconnect everything, so it
; only runs on a real uninstall.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Putting your AI apps' settings back…"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore'
  ${endIf}
!macroend
