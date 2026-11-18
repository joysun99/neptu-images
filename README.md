# Neptu runtime images

This is the canonical repository for **all future Neptu public image management
and publication**, as directed on 2026-11-18. Keep image definitions, pinned inputs,
verification and release workflows here. Deployment repositories consume the
verified published digest; existing image package names and historical releases
retain their identity. See [repository guidelines](AGENTS.md).

Node 24.16.0 production runtimes are published at `ghcr.io/joysun99/neptu-images`.
The shared Traefik runtime is published separately at
`ghcr.io/joysun99/neptu-traefik`; see [Shared Traefik runtime](#shared-traefik-runtime).
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

## Shared Traefik runtime

`traefik/` now owns the standalone Traefik build definition and publication
workflow. Keep using the shared package `ghcr.io/joysun99/neptu-traefik`; the
application repositories consume this image rather than building an ingress
image inside each application release. The existing Node runtime definitions
and workflow are independent and unchanged.

The imported baseline is **3.7.14-neptu1**, with checksum-pinned official source,
Go builder, Distroless base and `golang.org/x/net` patch. It was copied from
`neptu-global` revision `bb374e341e0174eaacbd483d34bac4c86fdf8fc3`;
[provenance](traefik/provenance.json) records the original Dockerfile checksum
and existing HKG image. The new context contains only the Dockerfile and Go
module download helper; no private application code, configuration, certificates
or credentials are required or included. The image defaults to UID/GID 65532;
existing deployments can retain their explicit `user: 1000:1000` for mounted
configuration and ACME storage. Ports remain 8080, 8443 and 8082.

Run from the repository root on Linux with Docker, Python 3 and OpenSSL:

```bash
docker buildx bake -f traefik/docker-bake.hcl --load
python3 traefik/smoke-test.py
python3 traefik/smoke-test.py --user 1000:1000
```

The smoke checks exercise non-root/read-only startup, version, health, HTTP,
HTTPS with SAN verification, and SNI/ALPN TLS passthrough sharing the HTTPS
port. Static `/ping` readiness is followed by a bounded 15-second wait for both
actual HTTP/HTTPS routes and the expected certificate, then fresh route and ALPN
assertions. Persistent route or certificate failures still fail publication.
All backends and certificates are disposable test fixtures, listening
only on loopback. Test containers are removed on completion.

The separate [Traefik workflow](.github/workflows/traefik.yml) builds and tests
PRs without publication. Main pushes affecting `traefik/`, `traefik-v*` tags,
and manual runs publish source tags `git-<full-git-sha>`; tag runs also publish
the Git release tag. There is no `latest` alias. Actions use `GITHUB_TOKEN`
with package write permission, publish build provenance, pull back the actual
published digest, and repeat both runtime-user checks. The Actions summary
records the deployment reference. For an existing GHCR package, grant this
repository **Write** under the package settings → **Manage Actions access**;
workflow `packages: write` alone does not grant access to another repository’s
existing package. See [GitHub package access documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
Package visibility is separate: set **Public** when anonymous pulls are required,
or retain authenticated pulls for a private package. Do not copy an operator
token into this repository to bypass package access setup.

This workflow does not build or publish the Node images. The existing `v*` tags remain reserved for Node releases; use
`traefik-v*` for Traefik releases.

Future deployment manifests must select the verified output by **digest**:

```text
ghcr.io/joysun99/neptu-traefik@sha256:<digest-from-successful-Traefik-workflow>
```

Verified central publication from source `7dee2ee0f2152299c104462d9746a3f4384ff0bc`:

```text
ghcr.io/joysun99/neptu-traefik@sha256:f4ce119ce03dc781b7e4c2d12d26d286668d8d84fe68aea61e19d8c59d4d979f
```

The [release receipt](releases/traefik-7dee2ee.json) records successful publication,
registry pullback and both runtime-user checks. After the package visibility was
changed to Public, the [public access verification](releases/traefik-7dee2ee-public-access.json)
confirmed anonymous token/manifest HTTP 200, the exact manifest SHA-256, and a
successful Docker pull with an empty client configuration and no supplied login
credentials. The original receipt retains its historical HTTP 401 observation;
the follow-up access evidence records the current public state. Publication and deployment are separate operations; production rollouts follow
the deployment repository’s site-specific plans.

Never deploy a moving source tag as a substitute for the reviewed digest.
Rebuilding the imported recipe creates a new image identity because source
labels and attestations change; it does not reproduce or replace the historical
HKG digest automatically. Existing offline archives and release records retain
their original image identity. Publication does not restart deployed services.
Production upgrades still need a site-specific plan and authorization.

The pre-rollout read-only inspection on 2026-11-18 recorded this historical HKG
baseline:

```text
ghcr.io/joysun99/neptu-traefik@sha256:acffd8c4f10796d5b34397431e7d7c62c4ace03b89f5a470f441a613965f6e3f
```

The same pre-rollout inspection recorded USG at
`sha256:de799a2a372626fefacf1e227283cd58b1e99b0433d8391e2392942ad104e6eb`
(3.7.13). These are historical import/rollback references. Subsequent deployments
use the verified central publication above, with their current site state and
execution evidence maintained by the deployment repository.

## cert-sync independent certificate service

The user-approved service/CLI name is **cert-sync**, with a new public-image family
`ghcr.io/joysun99/neptu-cert-sync`. See the [configuration and installation guide](cert-sync/README.md),
[examples](cert-sync/examples/leader.json), [source provenance](cert-sync/provenance.json),
and [local verification](cert-sync/verification.json).

This new implementation supports independent Leader/Follower roles, scoped Token
Join, authenticated HTTPS certificate synchronization, CLI/Web Console domain
configuration, and Traefik HTTP-01 forwarding and certificate reload. It requires
no node-to-node SSH authorization. Caddy adapters remain future work. Source,
Dockerfile and a separate opt-in publication workflow live here; no private
application layer or production certificate material is included.

The new runtime is locally verified and **unpublished**. Existing deployed
`neptu-global-dispatch-certificate-mirror` images and historical names remain
unchanged. Do not make the old application-based package public or treat the
new service as a drop-in replacement. Deployments need an exact published digest
and their own site plans; this repository does not restart production.
