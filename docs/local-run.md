# Run GitFoundry locally

This runs the current web application and API against a local SQLite database and local bare repositories. The local instance records a public locator outside Git so the `gfy` launcher can find the loopback API without copying token values into arguments or logs.

## Requirements

Use Node.js 26.6.0 or newer. Start in the repository root with the repository's prepared dependencies and built assets already present.

The current checkout's build and execution have been verified in this workspace. A clean dependency installation and an independent user's complete trial remain unverified.

## Start

```sh
./gfy local serve
```

Wait for the `gitfoundry.local.ready` record, then open the printed URL. The command defaults to http://127.0.0.1:4179; set `PORT` to use another loopback port.

Readiness writes the public locator at `/Users/douglance/.local/share/gitfoundry/local-instance.json`:

```json
{
  "url": "http://127.0.0.1:4179",
  "data_root": "...",
  "source_root": "...",
  "tenant": "local",
  "owner_token_file": "..."
}
```

The owner token file is private, mode `0600`, and must not be committed or pasted into logs.

## Operate through gfy

Use `./gfy` for repository reads, source snapshots, test runs, build runs, status, and logs. When `GFY_API_BASE_URL` is absent, non-local `./gfy` commands read the local instance locator and set `GFY_API_BASE_URL`, `GFY_TENANT_ID`, and `GFY_ACCESS_JWT_FILE` for the native CLI process. Explicit remote environment variables win. The launcher passes only the token file path; it never copies the token value into argv or logs.

```sh
./gfy forge head --tenant_id local --repository_id gitfoundry
./gfy local status RUN_ID
./gfy local logs RUN_ID
```

The local CLI uses the same loopback API as the browser and writes no token values to stdout. Test and build commands should run through `gfy local run` against an exact version, so the result records the fork version, exit status, and persisted log paths.

## Local CLI

`gfy local` is the self-hosting entrypoint. It is a thin client over generic local API endpoints; it does not know about test suites, workflows, or project recipes.

```sh
./gfy local import --source-path "$PWD" \
  --tenant-id local \
  --repository-id gitfoundry \
  --version-commit "${VERSION_COMMIT:-}" \
  --operation-id "local-import-$(date +%s)"

./gfy local snapshot --source-path "$PWD" \
  --version-commit "$VERSION_COMMIT" \
  --operation-id "local-snapshot-$(date +%s)"

./gfy local run \
  --version-commit "$VERSION_COMMIT" \
  --argv-json '["node","--version"]' \
  --operation-id "local-run-$(date +%s)"
```

The default API base is `GFY_URL` or http://127.0.0.1:4179. The default tenant is `GFY_TENANT_ID` or `local`. The default repository is `GFY_REPOSITORY_ID` or `gitfoundry`. Import sends `version_commit` as the supplied value or `null`; snapshot and run require an exact version. Local import, snapshot, run, status, and logs require the local owner identity. An explicit `--token-file` must contain an owner token and have mode `0600`. Without `--token-file`, the loopback server uses the development owner fallback.

Source changes become collaboration state by snapshotting a working tree into a fork. Build and test commands then run against that fork version:

```sh
./gfy local snapshot --source-path "$PWD" \
  --version-commit "$BASE_VERSION" \
  --operation-id "snapshot-$(date +%s)"

./gfy local run \
  --version-commit "$SNAPSHOT_VERSION" \
  --argv-json '["node","--test"]' \
  --operation-id "test-$(date +%s)"

./gfy local status "$RUN_ID"
./gfy local logs "$RUN_ID"
```

Do not use direct repository, package-manager, or compiler commands as the operational path for the forge. Use `./gfy local run` so the command, exit status, produced fork version, and logs are stored in repository-backed forge state.

Demo-agent tokens can authenticate ordinary API commands permitted by their persisted grants. They cannot use the owner-only local runner endpoints. Local fork and run responses therefore record the local owner identity.

## Local behavior

| Surface | Behavior |
| --- | --- |
| Identity | The loopback server supplies a signed development owner identity only when `Authorization` is absent. Ordinary API calls with a local demo JWT preserve that agent identity; local runner endpoints require the owner. Non-local `./gfy` commands use the locator's owner token file only when no explicit remote environment is set. |
| Access | Requests for other tenants or from other origins are denied. |
| Storage | SQLite and repository data remain in the selected local data directory. |
| Cloud execution | Cloudflare Durable Object, Artifacts and Container bindings are unavailable through this local adapter. |
| Qualification | Repository-shell CI has separate provider coverage; the local server does not establish the full native job controller or live provider qualification. |

For full acceptance, use [the acceptance plan](acceptance.md).

## Verified local evidence

Node 26.6.0 and pnpm 10.33.0 were measured. Root repository check passed `01a11fb7-2db1-7270-8b62-0894c7d98f0a`. Fresh isolated startup passed `01a11f9f-15aa-7343-bb8d-3063bc3ebfcf`; repository access and tenant/origin denial passed `01a11fa0-7aad-7a40-8726-5fbdb0cd23e1`. The [settled current browser capture](../output/local-trial-settled-20261009-081355.png) was inspected after actual local requests completed. These observations prove the bounded local setup, not all 80 requirements or an independent target-user trial.

tl;dr: Start the local instance with `./gfy local serve`, then use `./gfy` for repository reads, source snapshots, runs, status, and logs. This local setup supports development and inspection; full product and competition acceptance remain incomplete.
