#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
SOURCE_DIR="$PROJECT_DIR/source"
VERSION="$(<"$SOURCE_DIR/VERSION")"
OUTPUT_INPUT="${1:-"$PROJECT_DIR/dist"}"

/bin/mkdir -p "$OUTPUT_INPUT"
OUTPUT_DIR="$(cd "$OUTPUT_INPUT" && pwd)"

case "$OUTPUT_DIR" in
  "/"|"$HOME"|"$PROJECT_DIR")
    print -u2 -- "拒绝把构建产物写入高风险目录：$OUTPUT_DIR"
    exit 1
    ;;
esac

STAGING_DIR=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/codex-plus-pro-build.XXXXXX")
PACKAGE_DIR="$STAGING_DIR/Codex Plus Pro $VERSION"
ICONSET_DIR="$STAGING_DIR/AppIcon.iconset"
ICON_FILE="$STAGING_DIR/AppIcon.icns"

cleanup() {
  /bin/rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

/bin/mkdir -p "$PACKAGE_DIR" "$ICONSET_DIR"

for size in 16 32 128 256 512; do
  double_size=$((size * 2))
  /usr/bin/sips -z "$size" "$size" "$SOURCE_DIR/assets/mascot-transparent.png" \
    --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  /usr/bin/sips -z "$double_size" "$double_size" "$SOURCE_DIR/assets/mascot-transparent.png" \
    --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"

build_app() {
  local app_name="$1"
  local plist_name="$2"
  local executable_name="$3"
  local executable_source="$4"
  local include_theme="$5"
  local app_path="$PACKAGE_DIR/$app_name.app"

  /bin/mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources"
  /bin/cp "$SOURCE_DIR/$plist_name" "$app_path/Contents/Info.plist"
  /bin/cp "$executable_source" "$app_path/Contents/MacOS/$executable_name"
  /bin/chmod 755 "$app_path/Contents/MacOS/$executable_name"
  /bin/cp "$ICON_FILE" "$app_path/Contents/Resources/AppIcon.icns"

  if [[ "$include_theme" == "yes" ]]; then
    /bin/cp "$SOURCE_DIR/injector.mjs" "$app_path/Contents/Resources/injector.mjs"
    /bin/cp "$SOURCE_DIR/pet-notifications.js" "$app_path/Contents/Resources/pet-notifications.js"
    /bin/cp "$SOURCE_DIR/theme.css" "$app_path/Contents/Resources/theme.css"
    /bin/cp "$SOURCE_DIR/assets/pokemon-onsen.jpg" "$app_path/Contents/Resources/pokemon-onsen.jpg"
    /bin/cp "$SOURCE_DIR/assets/pokeball-logo-white.png" \
      "$app_path/Contents/Resources/pokeball-logo-white.png"
  fi

  /usr/bin/plutil -lint "$app_path/Contents/Info.plist" >/dev/null
  /usr/bin/xattr -cr "$app_path"
  /usr/bin/codesign --force --deep --sign - --timestamp=none "$app_path"
  /usr/bin/codesign --verify --deep --strict "$app_path"
}

build_app \
  "Codex Plus Pro" \
  "Info.plist" \
  "Codex-Plus-Pro" \
  "$SOURCE_DIR/launcher.zsh" \
  "yes"

build_app \
  "打开原版 Codex" \
  "Restore-Info.plist" \
  "Restore-Codex" \
  "$SOURCE_DIR/restore-original.zsh" \
  "no"

THEME_DESTINATION="$OUTPUT_DIR/Codex Plus Pro.app"
RESTORE_DESTINATION="$OUTPUT_DIR/打开原版 Codex.app"
ZIP_DESTINATION="$OUTPUT_DIR/Codex-Plus-Pro-$VERSION-macOS.zip"

/bin/rm -rf "$THEME_DESTINATION" "$RESTORE_DESTINATION"
/bin/rm -f "$ZIP_DESTINATION"
/usr/bin/ditto "$PACKAGE_DIR/Codex Plus Pro.app" "$THEME_DESTINATION"
/usr/bin/ditto "$PACKAGE_DIR/打开原版 Codex.app" "$RESTORE_DESTINATION"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$PACKAGE_DIR" "$ZIP_DESTINATION"

print -- "构建完成："
print -- "  $THEME_DESTINATION"
print -- "  $RESTORE_DESTINATION"
print -- "  $ZIP_DESTINATION"
