#!/usr/bin/env bash
# The strict worker's OS user (SMA map: Separate worker user, Worker runner task). Run once per machine by an admin; Lane Pilot uses it only
# with the project setting worker.strict_user = on (off by default). The machine's owner may then run commands as the worker without a password
# (sudo -n -u <worker>), keeping the sandbox's variables (SETENV); the worker gets folder rights per job from Lane Pilot (worker-user.ts).
#
#   scripts/lp-worker-user.sh create [user]   make the user (macOS dscl / Linux useradd) and the sudoers rule
#   scripts/lp-worker-user.sh check  [user]   the reachability probe Lane Pilot runs: sudo -n -u <user> true
#   scripts/lp-worker-user.sh grants          the list of granted rights (~/.lane-pilot/worker-grants.jsonl)
#   scripts/lp-worker-user.sh remove [user]   the sudoers rule and the user go
set -euo pipefail
USER_NAME="${2:-lp-worker}"
OWNER="${SUDO_USER:-$USER}"
RULE="/etc/sudoers.d/lp-worker-$OWNER"
[[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "bad user name: $USER_NAME" >&2; exit 2; }

create() {
  if id "$USER_NAME" >/dev/null 2>&1; then echo "user $USER_NAME exists"; else
    if [ "$(uname -s)" = "Darwin" ]; then
      local uid=499; while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$uid"; do uid=$((uid - 1)); done
      sudo dscl . -create "/Users/$USER_NAME"
      sudo dscl . -create "/Users/$USER_NAME" UserShell /bin/bash
      sudo dscl . -create "/Users/$USER_NAME" UniqueID "$uid"
      sudo dscl . -create "/Users/$USER_NAME" PrimaryGroupID 20
      sudo dscl . -create "/Users/$USER_NAME" NFSHomeDirectory "/var/empty"
      sudo dscl . -create "/Users/$USER_NAME" IsHidden 1
    else
      sudo useradd --system --no-create-home --shell /bin/bash "$USER_NAME"
    fi
    echo "user $USER_NAME made"
  fi
  printf '%s ALL=(%s) NOPASSWD:SETENV: ALL\n' "$OWNER" "$USER_NAME" | sudo tee "$RULE" >/dev/null
  sudo chmod 0440 "$RULE"
  sudo visudo -cf "$RULE" >/dev/null && echo "sudoers rule $RULE"
  check
}

check() {
  if sudo -n -u "$USER_NAME" /usr/bin/true 2>/dev/null; then echo "reachable: $OWNER runs as $USER_NAME without a password"; else echo "unreachable: run $0 create $USER_NAME as an admin"; exit 1; fi
}

case "${1:-check}" in
  create) create ;;
  check) check ;;
  grants) cat "$HOME/.lane-pilot/worker-grants.jsonl" 2>/dev/null || echo "no grants yet" ;;
  remove)
    sudo rm -f "$RULE"
    if [ "$(uname -s)" = "Darwin" ]; then sudo dscl . -delete "/Users/$USER_NAME" 2>/dev/null || true; else sudo userdel "$USER_NAME" 2>/dev/null || true; fi
    echo "removed $USER_NAME and $RULE" ;;
  *) echo "usage: $0 create|check|grants|remove [user]" >&2; exit 2 ;;
esac
