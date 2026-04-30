#!/bin/sh
# Runs before Eve Nexus is removed. Asks the user whether to keep app data.

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/io.evenexus.app"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/io.evenexus.app"

# Only prompt if there's actually data to remove.
if [ ! -d "$DATA_DIR" ] && [ ! -d "$CONFIG_DIR" ]; then
  exit 0
fi

KEEP=1

# Try zenity (GTK/GNOME), then kdialog (KDE), then fall back to silent keep.
if command -v zenity >/dev/null 2>&1 && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
  zenity --question \
    --title="Eve Nexus" \
    --text="Do you want to keep your Eve Nexus data (plans, settings, market cache)?\n\nClick Yes to keep it, No to remove everything." \
    --ok-label="Yes, keep my data" \
    --cancel-label="No, remove everything" 2>/dev/null
  KEEP=$?
elif command -v kdialog >/dev/null 2>&1 && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
  kdialog --yesno \
    "Do you want to keep your Eve Nexus data (plans, settings, market cache)?\n\nYes = keep, No = remove everything." \
    --title "Eve Nexus" 2>/dev/null
  KEEP=$?
fi

# zenity/kdialog return 0 for Yes, 1 for No.
if [ "$KEEP" -ne 0 ]; then
  rm -rf "$DATA_DIR"
  rm -rf "$CONFIG_DIR"
fi

exit 0
