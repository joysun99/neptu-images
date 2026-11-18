#!/usr/bin/env python3
"""Pull reviewed public GHCR digests with an isolated anonymous Docker client."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

REFERENCE = re.compile(r"ghcr\.io/[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}")
CREDENTIAL_ENV = ("DOCKER_AUTH_CONFIG", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "REGISTRY_AUTH_FILE")


def pinned_reference(value):
    if not REFERENCE.fullmatch(value):
        raise argparse.ArgumentTypeError("use a reviewed ghcr.io/repository@sha256:<64 lowercase hex> reference")
    return value


def positive_timeout(value):
    result = int(value)
    if not 1 <= result <= 900:
        raise argparse.ArgumentTypeError("timeout must be 1..900 seconds per image")
    return result


def pull(images, docker="docker", platform="linux/amd64", timeout=180):
    # Validate everything before starting any Docker operation, including library use.
    for ref in images:
        pinned_reference(ref)
    env = {key: value for key, value in os.environ.items() if key not in CREDENTIAL_ENV}
    results = []
    with tempfile.TemporaryDirectory(prefix="neptu-public-pull-") as directory:
        config = Path(directory, "config.json")
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("{}\n")
        client = [docker, "--config", directory, "--host", "unix:///var/run/docker.sock"]
        for ref in images:
            started = time.monotonic()
            pulled = subprocess.run(client + ["pull", "--platform", platform, ref], env=env,
                                    capture_output=True, text=True, timeout=timeout, check=False)
            if pulled.returncode:
                # Docker's public pull progress contains no supplied credentials.
                sys.stderr.write(pulled.stdout + pulled.stderr)
                raise RuntimeError("public digest pull failed; keep the running service and fix registry access before deployment")
            inspected = subprocess.run(client + ["image", "inspect", ref], env=env,
                                       capture_output=True, text=True, timeout=15, check=True)
            image = json.loads(inspected.stdout)[0]
            if ref not in image.get("RepoDigests", []):
                raise RuntimeError("the requested repository digest was not retained")
            actual_platform = image.get("Os", "") + "/" + image.get("Architecture", "")
            if actual_platform != platform:
                raise RuntimeError("the pulled image platform differs from the requested platform")
            labels = image.get("Config", {}).get("Labels") or {}
            results.append({"image": ref, "imageID": image["Id"], "platform": actual_platform,
                            "repoDigests": image["RepoDigests"],
                            "sourceCommit": labels.get("org.opencontainers.image.revision"),
                            "elapsedSeconds": round(time.monotonic() - started, 3)})
    return {"strategy": "direct-anonymous-ghcr-by-digest", "images": results,
            "existingCredentialsChanged": False, "servicesRestarted": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", type=pinned_reference, nargs="+")
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"), default="linux/amd64")
    parser.add_argument("--timeout-seconds", type=positive_timeout, default=180)
    parser.add_argument("--docker", default="docker", help="local Docker CLI executable")
    args = parser.parse_args()
    try:
        result = pull(args.images, args.docker, args.platform, args.timeout_seconds)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
