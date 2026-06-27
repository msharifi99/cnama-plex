#!/bin/sh
set -eu

APP_UID="${PUID:-1000}"
APP_GID="${PGID:-1000}"
SQLITE_PATH="${SQLITE_PATH:-/data/cnama.sqlite}"
DOWNLOAD_TMP_DIR="${DOWNLOAD_TMP_DIR:-/data/downloads}"

chown_app_path() {
  target="$1"

  case "$target" in
    /data | /data/*)
      chown -R "$APP_UID:$APP_GID" "$target" 2>/dev/null || true
      ;;
    *)
      chown "$APP_UID:$APP_GID" "$target" 2>/dev/null || true
      ;;
  esac
}

if [ "$(id -u)" = "0" ]; then
  sqlite_dir="$(dirname "$SQLITE_PATH")"

  mkdir -p "$sqlite_dir" "$DOWNLOAD_TMP_DIR"
  chown_app_path "$sqlite_dir"
  chown_app_path "$DOWNLOAD_TMP_DIR"

  for sqlite_file in "$SQLITE_PATH" "$SQLITE_PATH-wal" "$SQLITE_PATH-shm"; do
    if [ -e "$sqlite_file" ]; then
      chown "$APP_UID:$APP_GID" "$sqlite_file" 2>/dev/null || true
    fi
  done

  exec gosu "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
