# GDS Device Dispatch public runtime

This family packages an explicitly reviewed prebuilt static Go executable. The
application source remains in its original private repository. Only the binary,
public CA bundle and dependency licenses enter this image; production settings,
identities, credentials, certificates and business data never enter the context.

The image is published to the dedicated public `ghcr.io/joysun99/neptu-device-dispatch`
package with the reviewed SemVer application version as its tag. Verify the
published digest before deployment. Production adoption is authorized separately.

## Reviewed input and provenance

[input.lock.json](input.lock.json) binds the clean Go source commit, source-tree
fingerprint, version, native manifest SHA-256, exact binary bytes and public
release asset. The source native release is built and tested in the application
repository using its pinned toolchain. The raw executable alone is uploaded as a
public input release asset; the native archive and private source are excluded.
Updating any input requires a new reviewed lock and verification.

[prepare-input.py](prepare-input.py) accepts only the named public repository's
release assets, verifies exact size/SHA-256 and static Linux amd64 ELF structure,
and validates the included public license files. It writes a new ignored
`.inputs/` directory. Failed verification does not create build inputs.

Image revision identifies the Go source. `io.neptu.image.recipe-revision`
separately identifies this public recipe commit; neither identity replaces the
other. The image also carries source-tree, binary and native-manifest digests.
The manifest digest is provenance, not a bundled private native archive.

## Build, verify and publish

```bash
python3 gds-device-dispatch/test-input.py
python3 gds-device-dispatch/prepare-input.py
# Export the reviewed metadata from input.lock.json as in the scoped workflow.
docker buildx bake -f gds-device-dispatch/docker-bake.hcl --load
python3 gds-device-dispatch/smoke-test.py --image <built-image>
```

The workflow supplies all metadata from the validated lock via `--github-env`.
It builds and verifies on family changes; manual `publish=true` from main opts
into publication. It then anonymously pulls the exact published digest and
repeats actual runtime checks. A pushed image with failed pullback verification
is not a deployment candidate.

The minimal scratch runtime defaults to UID 65532, supports the existing site
UID 1000, runs `/gds` directly and includes the pinned official public CA bundle.
Verification checks both users with a read-only filesystem and no network,
actual binary bytes, version/source binding and capability profile. These checks
do not establish database ownership, serving eligibility or site acceptance.

## Deployment

Use [the common pull helper](../deploy/pull-public-image.py) with a reviewed exact
digest on each node. Retain the existing Compose project, foreground command,
config guards, mounts, identities, SQL targets and resource limits. Docker owns
the lifecycle with `unless-stopped`; no second daemon is added. Application
startup validates its original configuration and SQL/signature protections.
Site-specific recreation, verification and rollback follow the deployment
repository's exact authorization. Never initialize, import, join or replay a
business write merely because a container image changed.
