#!/bin/sh
set -eu
# Download retries keep verified modules in the same build layer's Go cache.
# Compilation runs separately with GOPROXY=off; checksum verification stays enabled.
attempt=1
while :; do
  if timeout --kill-after=10s 300s go "$@"; then
    exit 0
  else
    status=$?
  fi
  if [ "$attempt" -ge 3 ]; then
    printf 'Go module download failed after %s attempts (exit %s)\n' "$attempt" "$status" >&2
    exit "$status"
  fi
  printf 'Go module download attempt %s failed (exit %s); retrying in 5s\n' "$attempt" "$status" >&2
  sleep 5
  attempt=$((attempt + 1))
done
