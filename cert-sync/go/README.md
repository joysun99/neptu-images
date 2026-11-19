# Global Cert Sync Go runtime

This family publishes `ghcr.io/joysun99/neptu-cert-sync` from a reviewed **cert-only
static executable**. Application Go source remains private. The public context
contains the recipe, exact input lock, binary fetched from the named public
Release, dependency notices, verification and documentation. It contains no
application source, node configuration, identity, Token, private key or data.

Historical Node definitions and release evidence remain in the parent directory.
Each release publishes its service version tag and the
`go-git-<full-private-source-commit>` provenance tag from the same image target.
Check that the chosen version is available before publication. Record the
published digest with the version after anonymous verification. Historical Node
`git-*` tags retain their original meaning.

## Input and provenance

`input.lock.json` binds the clean private source commit, full-tree SHA256,
version, exact binary size/SHA256, candidate-manifest digest and license files.
The tree algorithm is SHA256 over `git ls-tree -rz --full-tree HEAD` bytes.
The private builder checks actual package dependencies: only the certificate CLI,
certificate service, canonical JSON utility and dedicated main are linked.
Device, Control and SQL implementations are excluded.

`prepare-input.py` validates the lock/notices, downloads only the fixed public
Release asset through HTTPS allowlisted redirects, and validates exact bytes and
static linux/amd64 ELF structure before writing a new ignored `.inputs/`.
The build never checks out the private application repository.

Image revision is the application source commit. `io.neptu.image.recipe-revision`
is the public recipe commit. Source-tree, binary and candidate-manifest digests
are recorded separately. `gds cert version` verifies actual executable metadata;
capability v5 describes implementation and keeps production qualification false.

## Build and publication

```bash
python3 cert-sync/go/test-input.py
python3 cert-sync/go/prepare-input.py --github-env
# The scoped workflow exports the reviewed metadata from the lock.
docker buildx bake -f cert-sync/go/docker-bake.hcl --load
python3 cert-sync/go/smoke-test.py --image ghcr.io/joysun99/neptu-cert-sync:go-git-<source-commit>
```

CI verifies on scoped main/PR changes. Manual `publish=true` from main publishes
only after verification, anonymously pulls back the exact resulting digest using
the common helper, and repeats actual image checks. A push without successful
pullback verification is not a deployment candidate. Node/Traefik/Device image
families are not rebuilt for this family change.

Runtime is scratch plus the pinned official public CA bundle, dependency notices
and the same stripped executable at `/gds` and `/usr/local/bin/cert-sync`.
Default UID remains **1000:1000** for Node-state compatibility. The smoke test
checks UID 1000 and 65532 command execution, owner-aligned foreground lifecycle,
read-only/no-capability/no-network operation, exact binary and CA, healthcheck,
absence of source/data, and original service identity across stop/start.
The host test UID is used for bind-mount ownership and must be nonroot.

## Commands and lifecycle

```bash
docker run --rm <verified-digest> version
docker run --rm <verified-digest> capabilities
docker exec <container> /gds cert status
docker exec <container> /gds cert probe
docker exec <container> cert-sync clients
```

The default foreground entry is `/gds cert serve`. Mount the host configuration
file read-only at `/etc/gds/cert/config.json` in the Compose service.

```yaml
volumes:
  - /absolute/host/config.json:/etc/gds/cert/config.json:ro
```

The image healthcheck and CLI use that path by default. For a different mount
target, pass the same explicit `--config PATH` to startup, the healthcheck and
CLI commands. The legacy executable
supports `check/init/run/status/domains/join/sync/create-join-token/revoke/clients/console`.
No Node interpreter, application daemon or second Docker process manager is used.

Keep the original schemaVersion 1 configuration, UID, state/target directories,
management Token, active client, service ID, generation files and Traefik mounts.
Startup never initializes missing settings or replaces an identity. An unjoined
Follower keeps its Console available for explicit Join. Docker/systemd own the
foreground process; Docker uses `unless-stopped`.

`status` is offline persisted health; `probe` checks actual local HTTP live,
certificate health and runtime readiness. `/healthz` retains certificate health;
`/livez` and `/readyz` are local backend observations. Management `/console` and
`/admin/*`, and original `/v1/join/*` and `/v1/certificates/*`, remain compatible.
Management credentials are file-based, private and owner-bound. Browser Tokens
stay in page memory and are cleared on logout.

Dependency retry defaults to six attempts, 1-second exponential waiting capped
at 30 seconds; exhaustion exits for Docker to restart the original process.
TLS/auth/content/state failures do not lower checks. Unknown effects retain their
intent; use explicit original recovery. Complete recovery and verify no pending
intent or unknown writer lock before a Node rollback. The persistent Go runtime
flock file releases on process death and is not removed to force takeover.

## Deployment boundary

Traefik continues ACME HTTP-01 issuance/renewal and Host-preserving challenge
routing; this service handles authorization, validation and certificate transfer.
The files output remains available; Caddy configuration/reload integration is
not included. External CA renewal and real-site acceptance remain site work.

Use the reviewed digest with `deploy/pull-public-image.py` on each authorized
node. Preserve old images and private data. The application repository owns
exact per-site HKG then USG adoption/rollback authorization; publication alone
does not authorize stopping, recreating or reconfiguring a production service.
