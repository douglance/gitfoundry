# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 rust:1.90-bookworm@sha256:3f6e6f8d8725a65a2db964bb828850f888d430c68784d661f753144e5d787207 AS supervisor-build
WORKDIR /src
COPY linux-runner/supervisor/Cargo.toml linux-runner/supervisor/Cargo.lock ./
COPY linux-runner/supervisor/src ./src
RUN cargo build --locked --release

FROM --platform=linux/amd64 debian:bookworm-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91
LABEL org.opencontainers.image.title="GitFoundry untrusted CI runner"
LABEL org.opencontainers.image.description="P0 untrusted CI image with no inherited provider credentials"
LABEL org.opencontainers.image.licenses="MIT; GPL-2.0-only; LGPL-2.1-or-later; BSD-3-Clause; ISC"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 curl=7.88.1-10+deb12u15 git=1:2.39.5-0+deb12u3 procps=2:4.0.2-3 coreutils=9.1-1 findutils=4.9.0-4 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/gitfoundry /work \
  && chmod 1777 /run/gitfoundry /work
COPY --from=supervisor-build /src/target/release/gitfoundry-supervise /usr/local/bin/gitfoundry-supervise
RUN ln -s /usr/local/bin/gitfoundry-supervise /usr/local/bin/gitfoundry-cancel
COPY ci-runner/gitfoundry-ci-step /usr/local/bin/gitfoundry-ci-step
RUN chmod 0755 /usr/local/bin/gitfoundry-ci-step
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
