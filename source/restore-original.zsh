#!/bin/zsh

set -u

STATE_DIR="$HOME/Library/Application Support/Codex-Plus-Pro"
PID_FILE="$STATE_DIR/injector.pid"
INJECTOR_JOB_LABEL="io.github.pikapikaspeedup.codex-plus-pro.injector"

/bin/launchctl remove "$INJECTOR_JOB_LABEL" >/dev/null 2>&1 || true

if [[ -f "$PID_FILE" ]]; then
  PID=$(<"$PID_FILE")
  if [[ "$PID" == <-> ]] && /bin/kill -0 "$PID" 2>/dev/null; then
    /bin/kill "$PID" 2>/dev/null || true
  fi
  /bin/rm -f "$PID_FILE"
fi

/usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null 2>&1 || true

for _ in {1..40}; do
  /usr/bin/pgrep -f '/(ChatGPT|Codex)\.app/Contents/MacOS/' >/dev/null 2>&1 || break
  /bin/sleep 0.25
done

for candidate in \
  "/Applications/ChatGPT.app" \
  "$HOME/Applications/ChatGPT.app" \
  "/Applications/Codex.app" \
  "$HOME/Applications/Codex.app"; do
  if [[ -d "$candidate" ]]; then
    /usr/bin/open "$candidate"
    exit 0
  fi
done

/usr/bin/osascript -e 'display alert "Codex Plus Pro" message "找不到官方 ChatGPT / Codex App。" as critical' >/dev/null 2>&1 || true
exit 1
