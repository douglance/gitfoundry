# syntax=docker/dockerfile:1
# GitFoundry official-runner control plane image.
# Upstream provenance:
# - ChristopherHX/runner.server commit 992ccbbbf9afcde477c38c316e053b1af457ad40
# - MIT license inherited from upstream repository.
ARG RUNNER_SERVER_SHA=992ccbbbf9afcde477c38c316e053b1af457ad40
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim@sha256:ec9c0a0dc5f60adc2065762050638dd5ed5facfc53716d4580a42d86027c8e80 AS build
ARG RUNNER_SERVER_SHA
WORKDIR /src
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && git clone https://github.com/ChristopherHX/runner.server.git . \
  && git checkout "$RUNNER_SERVER_SHA" \
  && dotnet msbuild src/dir.proj -t:GenerateConstant \
  && dotnet publish src/Runner.Server -c Release --no-self-contained -p:BUILD_OS=Any -p:RuntimeFrameworkVersion=8.0.0 -o /out/server \
  && dotnet publish src/Runner.Client -c Release --no-self-contained -p:BUILD_OS=Any -p:RuntimeFrameworkVersion=8.0.0 -o /out/client

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim@sha256:a3cd573ac05cf88ca496e3309cb7f7c44aa16664352d1ee41eda93154f50cdbf
LABEL org.opencontainers.image.title="GitFoundry GitHub Actions server"
LABEL org.opencontainers.image.description="Durable Effect wrapper for ChristopherHX runner.server, compatible with official actions/runner clients"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/ChristopherHX/runner.server/tree/992ccbbbf9afcde477c38c316e053b1af457ad40"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl nodejs npm python3 sqlite3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/gitfoundry /opt/runner/server /opt/runner/client /var/lib/gitfoundry/actions-server \
  && npm install --prefix /opt/gitfoundry --omit=dev effect@4.0.2 \
  && useradd --system --create-home --home-dir /home/gitfoundry --shell /usr/sbin/nologin gitfoundry \
  && chown -R gitfoundry:gitfoundry /opt/gitfoundry /var/lib/gitfoundry /home/gitfoundry
COPY --from=build /out/server /opt/runner/server
COPY --from=build /out/client /opt/runner/client
COPY github-actions-server/entrypoint.mjs /opt/gitfoundry/entrypoint.mjs
RUN chmod 0755 /opt/gitfoundry/entrypoint.mjs
USER gitfoundry
WORKDIR /opt/gitfoundry
EXPOSE 80
ENTRYPOINT ["node", "/opt/gitfoundry/entrypoint.mjs"]
