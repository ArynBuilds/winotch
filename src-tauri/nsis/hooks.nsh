; Uninstall hooks for the NSIS installer.
;
; The app stages winotch-hook.exe into %LOCALAPPDATA%\winotch\bin at launch, so
; the installer never recorded it and the default uninstaller leaves it behind.
; The inbox and the log live in the same place and are ours too. The rest of
; that folder (apps.json, today.json) is the user's data and stays.
;
; Claude Code's own settings.json and ~/.claude.json are deliberately NOT
; touched here: they belong to the user, they may hold other tools' hooks and
; servers, and rewriting somebody's config from an uninstaller with no diff and
; no consent is exactly what the rest of this app goes out of its way not to do.
; A relay that is gone exits 0 without printing anything, so a leftover hook
; entry costs nothing beyond a dead path; Settings → Claude Code removes both.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\winotch\bin"
  RMDir /r "$LOCALAPPDATA\winotch\inbox"
  Delete "$LOCALAPPDATA\winotch\winotch.log"
!macroend
