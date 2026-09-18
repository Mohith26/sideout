#!/bin/sh
# Container entrypoint (Dockerfile ENTRYPOINT). The image starts as root only
# long enough to make the persistent volume writable, then runs the command
# (Railway's start command or the Dockerfile CMD) as the unprivileged `node`
# user. Railway mounts a volume owned by root, so an image that switches user
# at build time cannot open the database file on it; this is the one place
# that ownership is fixed, and every process the app runs is non-root.
set -eu

DATA_DIR="$(dirname "${DATABASE_PATH:-/data/sideout.db}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
