#!/bin/sh
# Turns the phone into a dedicated Charm (no other apps visible) and back. No root needed.
# Run it yourself from the repo root:  sh scripts/charm-mode.sh plan | on | off | status
#   plan   lists what `on` would disable, changing nothing (run this first).
#   on     disables every app that has a home-screen icon, except Charm and a safety allowlist,
#          and makes Charm the home screen. The list of disabled apps is saved so `off` restores exactly them.
#   off    re-enables those apps.
# Uses `adb` from scripts/env.sh. Set ADB_SERIAL to pick a phone if more than one is connected.
# Note: the keep-list (KEEP below) is tuned for Realme/ColorOS. On another phone, run `plan` first and add any
# package your phone needs (its clock, keyboard, dialer or security app) to KEEP before running `on`.
set -eu

cd "$(dirname "$0")/.."
. scripts/env.sh

CHARM=io.github.haardhikk.charm
SAVED=.cache/charm-disabled.txt
# Never disabled: Charm itself, Settings (the way back), the dialer for emergency calls,
# and the engines Charm needs (web view for the character, speech and text-to-speech, permissions).
# Also kept on Realme/ColorOS: contacts (the phone icon), the clock (alarms), messages, keyboards and security.
KEEP="$CHARM com.android.settings com.android.dialer com.google.android.dialer com.android.phone com.android.contacts \
com.google.android.webview com.android.webview com.google.android.tts com.google.android.googlequicksearchbox \
com.android.permissioncontroller com.google.android.permissioncontroller com.android.systemui \
com.coloros.alarmclock com.android.deskclock com.oneplus.deskclock com.android.mms com.google.android.apps.messaging \
com.coloros.safecenter com.coloros.phonemanager com.google.android.inputmethod.latin com.android.inputmethod.latin \
com.sohu.inputmethod.sogouoem com.coloros.gamespace"


adb_() { if [ -n "${ADB_SERIAL:-}" ]; then adb -s "$ADB_SERIAL" "$@"; else adb "$@"; fi; }

require_phone() {
  [ "$(adb_ get-state 2>/dev/null)" = "device" ] || { echo "No phone connected (adb get-state failed). Nothing changed."; exit 1; }
}

to_disable() {
  for pkg in $(launcher_apps); do
    case " $KEEP " in *" $pkg "*) continue ;; esac
    echo "$pkg"
  done
}

launcher_apps() {
  adb_ shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
    | tr -d '\r' | grep '/' | sed 's#/.*##' | sort -u
}

case "${1:-status}" in
  plan)
    require_phone
    echo "\`on\` would disable:"
    to_disable
    ;;
  on)
    require_phone
    for pkg in $(to_disable); do
      if adb_ shell pm disable-user --user 0 "$pkg" </dev/null >/dev/null 2>&1; then
        echo "$pkg" >> "$SAVED" # recorded at once, so an interrupted run can still be undone
        echo "off: $pkg"
      else
        echo "could not disable (left on): $pkg"
      fi
    done
    [ -f "$SAVED" ] && sort -u -o "$SAVED" "$SAVED"
    adb_ shell cmd package set-home-activity "$CHARM/.MainActivity" >/dev/null && echo "Charm is the home screen"
    echo "Charm mode on. Undo with: sh scripts/charm-mode.sh off"
    ;;
  off)
    [ -f "$SAVED" ] || { echo "nothing to restore ($SAVED missing)"; exit 0; }
    require_phone
    : > "$SAVED.left"
    while read -r pkg; do
      [ -n "$pkg" ] || continue
      if adb_ shell pm enable --user 0 "$pkg" </dev/null >/dev/null 2>&1; then echo "on: $pkg"; else echo "$pkg" >> "$SAVED.left"; echo "FAILED: $pkg"; fi
    done < "$SAVED"
    if [ -s "$SAVED.left" ]; then
      mv "$SAVED.left" "$SAVED"
      echo "Some apps are still off; run 'off' again. The list is kept in $SAVED."
    else
      rm -f "$SAVED" "$SAVED.left"
      echo "All apps restored. Pick your old home screen in Settings → Home screen if Android asks."
    fi
    ;;
  status)
    echo "Apps with home-screen icons:"
    launcher_apps
    [ -f "$SAVED" ] && echo "Disabled by Charm mode: $(wc -l < "$SAVED" | tr -d ' ')" || echo "Charm mode is off."
    ;;
  *)
    echo "usage: sh scripts/charm-mode.sh plan | on | off | status"
    exit 2
    ;;
esac
