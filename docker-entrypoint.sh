#!/bin/sh
# Runs as root (the image's default ENTRYPOINT user) so it can fix
# ownership of a mounted volume before dropping to the unprivileged
# 'node' user to actually run the app. This matters specifically for
# platforms like Railway: an attached persistent volume is mounted fresh
# at container start and typically owned by root regardless of what the
# image's Dockerfile chown'd at build time, so without this the app would
# crash-loop on its first real write to SQLITE_PATH with EACCES.
set -e
mkdir -p /app/data
chown -R node:node /app/data
exec gosu node "$@"
