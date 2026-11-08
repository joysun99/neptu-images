#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/joysun99/neptu-images}"
REVISION="${REVISION:-local}"
for variant in slim ffmpeg; do
  image="$IMAGE_NAME:node-24-$variant-sha-$REVISION"
  [[ "$(docker image inspect "$image" --format '{{json .Config.Entrypoint}}')" == '["tini","--"]' ]]
  [[ "$(docker image inspect "$image" --format '{{json .Config.Cmd}}')" == '["sleep","infinity"]' ]]
  docker run --rm --network none --read-only --tmpfs /tmp:size=64m,mode=1777 \
    --security-opt no-new-privileges:true --cap-drop ALL \
    -v "$ROOT:/checks:ro" "$image" node /checks/scripts/verify-runtime.mjs "$variant"
done
