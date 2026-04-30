; Eve Nexus NSIS installer hooks

!macro NSIS_HOOK_PREUNINSTALL
  ; Ask the user whether to keep their plans, settings and cache.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you want to keep your Eve Nexus data (plans, settings, market cache)?$\n$\nClick Yes to keep it, No to remove everything." \
    IDYES eve_nexus_keep_data

  ; User chose No — delete all app data.
  RMDir /r "$APPDATA\io.evenexus.app"
  RMDir /r "$LOCALAPPDATA\io.evenexus.app"

  eve_nexus_keep_data:
!macroend
