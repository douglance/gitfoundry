# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node-runtime
FROM --platform=linux/amd64 rust:1.90-bookworm@sha256:3f6e6f8d8725a65a2db964bb828850f888d430c68784d661f753144e5d787207 AS supervisor-build
WORKDIR /src
COPY linux-runner/supervisor/Cargo.toml linux-runner/supervisor/Cargo.lock ./
COPY linux-runner/supervisor/src ./src
RUN cargo build --locked --release

FROM --platform=linux/amd64 debian:bookworm-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91
LABEL org.opencontainers.image.title="GitFoundry trusted Git helper"
LABEL org.opencontainers.image.description="P0 trusted Git helper image; receives short-lived helper tokens only through admitted exec env/stdin"
LABEL org.opencontainers.image.licenses="MIT; GPL-2.0-only; LGPL-2.1-or-later; BSD-3-Clause; ISC"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 curl=7.88.1-10+deb12u15 git=1:2.39.5-0+deb12u3 procps=2:4.0.2-3 coreutils=9.1-1 findutils=4.9.0-4 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/gitfoundry /work \
  && chmod 1777 /run/gitfoundry /work
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY git-helper/git-cli.mjs /usr/local/bin/git-cli.mjs
COPY git-helper/gitfoundry-forge-rpc /usr/local/bin/gitfoundry-forge-rpc
RUN chmod 0755 /usr/local/bin/gitfoundry-forge-rpc
COPY --from=supervisor-build /src/target/release/gitfoundry-supervise /usr/local/bin/gitfoundry-supervise
RUN ln -s /usr/local/bin/gitfoundry-supervise /usr/local/bin/gitfoundry-cancel
COPY git-helper/gitfoundry-git-helper /usr/local/bin/gitfoundry-git-helper
COPY git-helper/gitfoundry-merge-candidate /usr/local/bin/gitfoundry-merge-candidate
COPY git-helper/gitfoundry-source-pack /usr/local/bin/gitfoundry-source-pack
COPY git-helper/gitfoundry-hydrate-source /usr/local/bin/gitfoundry-hydrate-source
RUN chmod 0755 /usr/local/bin/gitfoundry-git-helper /usr/local/bin/gitfoundry-merge-candidate /usr/local/bin/gitfoundry-source-pack /usr/local/bin/gitfoundry-hydrate-source
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
