# Official public CA bundle only; no production or node certificate material.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS trust
FROM scratch AS runtime
ARG GDS_VERSION
ARG SOURCE_COMMIT
ARG SOURCE_TREE
ARG BINARY_SHA256
ARG NATIVE_MANIFEST_SHA256
ARG RECIPE_COMMIT
LABEL org.opencontainers.image.title="Neptu GDS Device Dispatch" \
      org.opencontainers.image.source="https://github.com/joysun99/neptu-images" \
      org.opencontainers.image.version="$GDS_VERSION" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      io.neptu.image.recipe-revision="$RECIPE_COMMIT" \
      com.smartgds.source-tree="$SOURCE_TREE" \
      com.smartgds.binary-sha256="$BINARY_SHA256" \
      com.smartgds.native-manifest="$NATIVE_MANIFEST_SHA256"
COPY --chmod=0555 .inputs/gds /gds
COPY --from=trust /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY licenses/ /usr/share/licenses/gds/
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 65532:65532
WORKDIR /
STOPSIGNAL SIGTERM
ENTRYPOINT ["/gds"]
CMD ["help"]
