# Rebuild the checksum-verified official source with patched Go dependencies.
FROM golang:1.26.9-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS build
ADD --checksum=sha256:a5c89da12e74890a2b3aeecf46756ee853a6e8c1e9e27a04fa1ebdaefc68d4ce \
  https://github.com/traefik/traefik/releases/download/v3.7.14/traefik-v3.7.14.src.tar.gz /tmp/traefik-src.tar.gz
COPY go-module-download.sh /usr/local/bin/go-module-download.sh
WORKDIR /src
RUN tar -xzf /tmp/traefik-src.tar.gz -C /src \
 && test -s webui/static/index.html \
 && sh /usr/local/bin/go-module-download.sh get golang.org/x/net@v0.60.0 \
 && sh /usr/local/bin/go-module-download.sh mod download \
 && go mod verify
RUN GOPROXY=off CGO_ENABLED=0 go build -mod=readonly -buildvcs=false -trimpath \
      -ldflags="-s -w -X github.com/traefik/traefik/v3/pkg/version.Version=3.7.14-neptu1 -X github.com/traefik/traefik/v3/pkg/version.BuildDate=2026-10-10T00:00:00Z" \
      -o /out/traefik ./cmd/traefik

FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3

LABEL org.opencontainers.image.title="Neptu Traefik Runtime" \
      org.opencontainers.image.vendor="CapeLabs" \
      org.opencontainers.image.version="3.7.14-neptu1" \
      org.opencontainers.image.source="https://github.com/joysun99/neptu-images" \
      org.opencontainers.image.url="https://github.com/traefik/traefik"

COPY --from=build /out/traefik /usr/local/bin/traefik

USER 65532:65532
EXPOSE 8080 8443 8082
ENTRYPOINT ["/usr/local/bin/traefik"]
