# Reviewed static cert-only binary plus the pinned official public CA bundle.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS trust
FROM scratch AS runtime
ARG CERT_VERSION
ARG SOURCE_COMMIT
ARG SOURCE_TREE
ARG BINARY_SHA256
ARG CANDIDATE_MANIFEST_SHA256
ARG RECIPE_COMMIT
LABEL org.opencontainers.image.title="Global Cert Sync" \
      org.opencontainers.image.source="https://github.com/joysun99/neptu-images" \
      org.opencontainers.image.version="$CERT_VERSION" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      io.neptu.image.recipe-revision="$RECIPE_COMMIT" \
      io.neptu.cert-sync.source-tree="$SOURCE_TREE" \
      io.neptu.cert-sync.binary-sha256="$BINARY_SHA256" \
      io.neptu.cert-sync.candidate-manifest="$CANDIDATE_MANIFEST_SHA256"
COPY --chmod=0555 .inputs/gds /gds
COPY --chmod=0555 .inputs/gds /usr/local/bin/cert-sync
COPY --from=trust /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY licenses/ /usr/share/licenses/cert-sync/
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 1000:1000
WORKDIR /
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/gds","cert"]
CMD ["serve","--config","/etc/neptu/cert-sync.json"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 CMD ["/gds","cert","probe","--config","/etc/neptu/cert-sync.json"]
