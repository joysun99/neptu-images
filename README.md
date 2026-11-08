# Neptu runtime images

Node 24.16.0 production runtimes, published at `ghcr.io/joysun99/neptu-images`.
The supported platform is `linux/amd64`, matching KO. Images run as UID 1000
(`node`) in `/app`, with `tini --` as entrypoint and `sleep infinity` as default
command. pnpm is fixed at 10.33.0. Read-only containers need a writable `/tmp`.

| Tag | Purpose |
| --- | --- |
| `node-24-slim` | Existing Neptu Node runtime contract, without FFmpeg |
| `node-24-ffmpeg` / `node-24-ffmpeg-7.0.2` | Same Slim base with checksum-pinned FFmpeg 7.0.2-static |
| `node-24-<variant>-sha-<full-git-sha>` | Source-specific tags for deployment pinning |
| `node-24-<variant>-v<release>` | Tags generated when pushing a `v*` Git tag |

`node-24/Dockerfile-Slim` matches the definition previously used for
`ghcr.io/wingsun97/neptu:node-24-slim`. The official Node 24.16.0 Bookworm base is now pinned by
digest to prevent silent upgrades. This repository publishes to its own namespace;
it does not overwrite `ghcr.io/wingsun97/neptu`.

The FFmpeg Dockerfile reuses the Slim Bake target directly, so a first build and
fork PR do not require a prepublished Slim image or registry credentials. Only the
build environment downloads FFmpeg, with retry and SHA-256 checks. The release
asset is named `b6.1.1`, but the verified executable reports **7.0.2-static**.
`node-24/ffmpeg.lock.json` fixes the compressed binary, uncompressed binary,
README and LICENSE hashes. License and upstream source/build information ship
in `/usr/local/share/licenses/ffmpeg/`.

`FFMPEG_BIN=/usr/local/bin/ffmpeg` lets the application's `ffmpeg-static` package
find the installed executable and skip its binary download. No global
`ffmpeg-static` npm package is installed. `FFMPEG_BINARY_SHA256` also supports the
application's full-release integrity validator.

## Build and validate

```bash
docker buildx bake --load
bash scripts/smoke-test.sh
```

Both images must pass non-root/read-only/network-disabled runtime checks. FFmpeg
must also pass SHA-256, version, MP3 and Opus encoding checks before publication.
Bake links the two Dockerfiles through the `runtime-base` named context; use Bake
for the combined build. A standalone FFmpeg build can use
`--build-arg BASE_IMAGE=<published-slim-image>`.

Pushes affecting build files on `main`, `v*` tags, and manual runs trigger GitHub
Actions. Pull requests build and test without logging in or publishing. On main,
Actions publishes the stable aliases and full-SHA tags using `GITHUB_TOKEN` with
`packages: write`; tagged releases publish release/SHA tags without moving main's
stable aliases. Workflow Actions are pinned to reviewed commits. The summary
records each registry digest; production should pin digests.

## Deploy independently of application archives

```bash
docker pull ghcr.io/joysun99/neptu-images:node-24-slim
docker pull ghcr.io/joysun99/neptu-images:node-24-ffmpeg-7.0.2
export NEPTU_RUNTIME_IMAGE=ghcr.io/joysun99/neptu-images:node-24-slim
export NEPTU_FFMPEG_RUNTIME_IMAGE=ghcr.io/joysun99/neptu-images:node-24-ffmpeg-7.0.2
```

Persist these settings using the deployment repository's regional configuration
before rolling out services. Existing deployment defaults still reference
`ghcr.io/wingsun97/neptu`; publishing here does not update running containers.
Keep runtime images separate from application/dependency archives when registry
access is available. Existing full offline archives still include runtime images;
their installer checks exact image IDs, so do not replace or remove their image
files by hand.

GHCR packages must be publicly readable if servers pull without authentication.
For a private package, configure registry authentication separately. Never place
registry tokens in a Dockerfile, build argument, archive, or repository file.
