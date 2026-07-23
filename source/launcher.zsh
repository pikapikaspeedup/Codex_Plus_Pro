#!/bin/zsh

set -u

RESOURCE_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG_DIR="$HOME/Library/Logs"
STATE_DIR="$HOME/Library/Application Support/Codex-Plus-Pro"
LOG_FILE="$LOG_DIR/Codex-Plus-Pro.log"
PID_FILE="$STATE_DIR/injector.pid"
INJECTOR_JOB_LABEL="io.github.pikapikaspeedup.codex-plus-pro.injector"

mkdir -p "$LOG_DIR" "$STATE_DIR"

/bin/launchctl remove "$INJECTOR_JOB_LABEL" >/dev/null 2>&1 || true

find_codex_app() {
  local candidate
  for candidate in \
    "/Applications/ChatGPT.app" \
    "$HOME/Applications/ChatGPT.app" \
    "/Applications/Codex.app" \
    "$HOME/Applications/Codex.app"; do
    if [[ -d "$candidate" && -f "$candidate/Contents/Info.plist" ]]; then
      local bundle_id
      bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$candidate/Contents/Info.plist" 2>/dev/null || true)
      if [[ "$bundle_id" == "com.openai.codex" ]]; then
        print -r -- "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

show_error() {
  local message="$1"
  /usr/bin/osascript -e "display alert \"Codex Plus Pro\" message \"$message\" as critical" >/dev/null 2>&1 || true
}

CODEX_APP=$(find_codex_app) || {
  show_error "找不到官方 ChatGPT / Codex App。请先把官方 App 放进 Applications 文件夹。"
  exit 1
}

APP_EXECUTABLE_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$CODEX_APP/Contents/Info.plist" 2>/dev/null)
APP_EXECUTABLE="$CODEX_APP/Contents/MacOS/$APP_EXECUTABLE_NAME"
NODE_EXECUTABLE="$CODEX_APP/Contents/Resources/cua_node/bin/node"

if [[ ! -x "$APP_EXECUTABLE" ]]; then
  show_error "官方 Codex App 缺少可执行文件，建议重新安装官方版本。"
  exit 1
fi

if [[ ! -x "$NODE_EXECUTABLE" ]]; then
  NODE_EXECUTABLE=$(command -v node 2>/dev/null || true)
fi

if [[ -z "${NODE_EXECUTABLE:-}" || ! -x "$NODE_EXECUTABLE" ]]; then
  show_error "找不到主题运行所需的 Node.js。请更新官方 Codex App 后重试。"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(<"$PID_FILE")
  if [[ "$OLD_PID" == <-> ]] && /bin/kill -0 "$OLD_PID" 2>/dev/null; then
    /bin/kill "$OLD_PID" 2>/dev/null || true
  fi
  /bin/rm -f "$PID_FILE"
fi

if /usr/bin/pgrep -f "$APP_EXECUTABLE" >/dev/null 2>&1; then
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null 2>&1 || true
  for _ in {1..40}; do
    /usr/bin/pgrep -f "$APP_EXECUTABLE" >/dev/null 2>&1 || break
    /bin/sleep 0.25
  done
fi

if /usr/bin/pgrep -f "$APP_EXECUTABLE" >/dev/null 2>&1; then
  show_error "官方 Codex 仍在运行。请先正常退出它，再重新打开 Codex Plus Pro。"
  exit 1
fi

find_available_port() {
  local port="$1"
  local last_port="$2"
  while /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
    if (( port > last_port )); then
      return 1
    fi
  done
  print -r -- "$port"
}

RENDERER_PORT=$(find_available_port 9347 9397) || {
  show_error "没有找到可用的页面调试端口。请重启 Mac 后再试。"
  exit 1
}

MAIN_PORT=$(find_available_port 9398 9448) || {
  show_error "没有找到可用的窗口控制端口。请重启 Mac 后再试。"
  exit 1
}

{
  print -r -- "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Codex Plus Pro"
  print -r -- "Official app: $CODEX_APP"
  print -r -- "Renderer loopback port: $RENDERER_PORT"
  print -r -- "Main-process loopback port: $MAIN_PORT"
} >| "$LOG_FILE"

/usr/bin/nohup "$APP_EXECUTABLE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$RENDERER_PORT" \
  --inspect="127.0.0.1:$MAIN_PORT" \
  >>"$LOG_FILE" 2>&1 &

APP_PID=$!

/usr/bin/nohup /bin/zsh -c '
  set -u

  app_pid="$1"
  shift
  child_pid=""

  cleanup() {
    if [[ -n "$child_pid" ]] && /bin/kill -0 "$child_pid" 2>/dev/null; then
      /bin/kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
  }

  trap "cleanup; exit 0" HUP INT TERM

  while /bin/kill -0 "$app_pid" 2>/dev/null; do
    "$@" &
    child_pid=$!
    wait "$child_pid"
    child_status=$?
    child_pid=""

    /bin/kill -0 "$app_pid" 2>/dev/null || break
    print -r -- "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Injector exited with status $child_status; restarting"
    /bin/sleep 1
  done
' codex-plus-pro-injector-supervisor \
  "$APP_PID" \
  "$NODE_EXECUTABLE" \
  "$RESOURCE_DIR/injector.mjs" \
  --port "$RENDERER_PORT" \
  --main-port "$MAIN_PORT" \
  --css "$RESOURCE_DIR/theme.css" \
  --wallpaper "$RESOURCE_DIR/pokemon-onsen.jpg" \
  --logo "$RESOURCE_DIR/pokeball-logo-white.png" \
  >>"$LOG_FILE" 2>&1 &

INJECTOR_PID=$!
print -r -- "$INJECTOR_PID" >| "$PID_FILE"

for _ in {1..60}; do
  if /usr/bin/curl -fsS --max-time 0.4 "http://127.0.0.1:$RENDERER_PORT/json/version" >/dev/null 2>&1; then
    break
  fi
  /bin/kill -0 "$APP_PID" 2>/dev/null || break
  /bin/sleep 0.25
done

/usr/bin/open "$CODEX_APP" >/dev/null 2>&1 || true

exit 0
