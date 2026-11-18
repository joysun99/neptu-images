# Independent service: no private application layer or SSH dependency.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
LABEL org.opencontainers.image.title="Neptu cert-sync" \
      org.opencontainers.image.source="https://github.com/joysun99/neptu-images" \
      org.opencontainers.image.version="0.1.0"
WORKDIR /opt/neptu/cert-sync
COPY --chown=1000:1000 app.mjs certificates.mjs config.mjs store.mjs proxy.mjs console.mjs ./
COPY cert-sync /usr/local/bin/cert-sync
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["cert-sync"]
HEALTHCHECK --interval=60s --timeout=15s --start-period=30s --retries=3 CMD ["cert-sync","status","--config","/etc/neptu/cert-sync.json"]
CMD ["run","--config","/etc/neptu/cert-sync.json"]

# Test-only OpenSSL and synthetic fixtures never enter the runtime target.
FROM runtime AS test
USER root
RUN mkdir -p /etc/ssl/certs \
 && node -e 'require("node:fs").writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("node:tls").rootCertificates.join("\n") + "\n")' \
 && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' 'Acquire::Retries "3";' 'Acquire::https::Timeout "30";' > /etc/apt/apt.conf.d/80-neptu-download \
 && apt-get update --error-on=any \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
COPY --chown=1000:1000 cert-sync.test.mjs ./
USER 1000:1000
ENTRYPOINT ["node","--test","/opt/neptu/cert-sync/cert-sync.test.mjs"]
