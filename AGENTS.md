# Repository Guidelines

## Ownership

This repository is the canonical management and publication repository for all
future Neptu public container images, as directed by the user on 2026-11-18.
Keep public image Dockerfiles, build helpers, pinned inputs, verification,
publication workflows and usage documentation here. Application and deployment
repositories consume the verified published image by digest. Introduce new
public image families here instead of adding another publication owner.

Keep existing package names unless a package rename is explicitly requested.
Imported definitions must record the original repository/revision/checksum.
Historical release receipts and deployed digests retain their original identity;
a new build must receive its own publication evidence. Source/application images
requiring private code need an explicit private build input contract; do not copy
private business code, credentials, deployment configuration or certificates into
this public repository.

## Current Image Families

- Node 24 Slim and FFmpeg: root `docker-bake.hcl`, `node-24/`, and
  `.github/workflows/build.yml`; package `ghcr.io/joysun99/neptu-images`.
- GDS Device Dispatch: `gds-device-dispatch/` and its scoped workflow; the existing
  `ghcr.io/joysun99/neptu-images` package, isolated `gds-device-dispatch-git-*` tags.
  Use the approved prebuilt binary input contract; private Go source stays private.
- Traefik: `traefik/`, `traefik/docker-bake.hcl`, and
  `.github/workflows/traefik.yml`; package `ghcr.io/joysun99/neptu-traefik`.

- cert-sync: `cert-sync/` and `.github/workflows/cert-sync.yml`; package
  `ghcr.io/joysun99/neptu-cert-sync`. The user explicitly approved this new name;
  the legacy private certificate-mirror package retains its historical identity.

The user confirmed a future Go replacement for cert-sync with private application
source and a public runtime image. Keep only that future image definition,
reviewed binary input, licenses, verification and publication here. The current
Node sources/image are already public historical implementation; do not claim
that a repository move conceals JavaScript shipped in a public image. The Go
runtime now uses `cert-sync/go/` and the scoped cert-sync workflow with reviewed
cert-only binary input; current Node files/receipts remain historical references.

Keep workflows scoped to their image families. Node releases use `v*` Git tags;
Traefik releases use `traefik-v*`. Changes to root scripts/Bake/ignore files can
trigger Node publication, so use a family-local build context for independent
images. Do not rebuild unrelated images merely to add documentation or a family. cert-sync
PR/main runs verify only; its manual publish input opts in to publication from main.

## Build and Publication

Pin base images by digest and fetched artifacts by checksum. Retain reviewed
upstream/dependency versions when importing a definition; version upgrades need
their own rationale and checks. Pin workflow Actions by commit. Build with a
minimal context and no production material or registry token build arguments.

Verify the actual image before publication, then pull back the published digest
and repeat relevant runtime checks. Source tags identify code; deployment uses
`repository@sha256:...`. Record actual source commit, platform, published digest
and verification result. A successful push alone is not production qualification.
GHCR packages intended for unauthenticated pulls must be public.

Deployment pulls for public GHCR images use `deploy/pull-public-image.py` on each
node: an isolated empty Docker client configuration, the local Unix daemon and
an exact reviewed repository digest. Do not reuse stored login credentials or
relay image archives by default. Failed pulls stop preparation before service
changes; preserve original credentials and historical transport receipts.

From the repository root:

```bash
docker buildx bake --load
bash scripts/smoke-test.sh

docker buildx bake -f traefik/docker-bake.hcl --load
python3 traefik/smoke-test.py
python3 traefik/smoke-test.py --user 1000:1000
```

Docker and systemd deployments run the service in the foreground; external
supervision owns process start/stop/restart. Do not add an application daemon or
a second host process manager around Docker containers. Production containers
use `unless-stopped`; `no` is limited to explicitly stopped maintenance/shadow
scopes. Dependency retries default to six attempts, 1-second exponential delay
capped at 30 seconds, then process exit; retain state/identity and last verified
certificates. Never retry unknown writes or weaken TLS/authorization checks.

Run checks relevant to the changed image. Documentation-only changes need link,
structure and diff checks. Do not restart production services as part of image
publication; follow each deployment repository's site authorization requirements.
