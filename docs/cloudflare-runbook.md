# Cloudflare preparation and operations

Audience: the platform implementer and operator. Outcome: target the correct account and avoid competing infrastructure ownership.

Status: staging and separate production resources are provisioned. Production uses `https://gitfoundry.dev` and `https://mcp.gitfoundry.dev`. See [production domain evidence](production-domain-evidence.md) for the exact release, live checks and owner-browser DNS blocker.

## Confirmed target and tools

| Item | Baseline |
| --- | --- |
| Owner alias | doug-lance |
| Confirmed account ID | 88f9cbf5c4f4e217079bcbf0ca6cb181 |
| cf-returned account name | Doug.lance@gmail.com's Account |
| Account confirmation | Owner explicitly selected this ID |
| Inspected cf version | 1.0.0-beta.13 on October 8, 2026 (UTC) |
| Authentication observation | cf auth whoami returned authenticated and tokenValid; only this account was listed |
| Infrastructure owner | Alchemy |
| Domain services | Effect |
| Environments | gitfoundry-staging and gitfoundry-production, with separate state |
| Initial public routing | Use qualified Workers endpoints until an owner-approved custom domain is configured |
| Unverified inputs | Alchemy credentials, required service entitlements, tenant IdP/directory and source migration authorization |

The alias is not a verified Access team hostname or domain. Do not infer either from the account label.

## Tool ownership

| Action | Tool / constraint |
| --- | --- |
| Declare, provision and publish managed infrastructure | Locked Alchemy application; explicit account and environment state |
| Discover exact Cloudflare API commands | cf cli search with anonymous action/resource descriptions |
| Inspect account/resources, qualify providers and read operational data | Discovered cf commands, with explicit target account |
| Reconcile deployments, bindings, migrations and managed-resource changes | Alchemy ownership; cf may inspect, not create a second desired-state graph |
| Compile/typecheck/test | Explicit locked build commands through apoc; cf does not automatically execute package scripts |
| Edit source/configuration/generated files or persist reports | griz, including binary creation and generated content |

Do not run cf init, migrate, build, deploy or dry-run initialization against this documentation-only folder. These commands can initialize project files or install dependencies; cf deploy may provision missing bindings and would compete with Alchemy ownership.

## Read-only preparation

Run the following exact child argv through installed apoc Code Mode; these are command references, not a bypass for host-operation guidance:

```sh
cf --version
cf auth whoami
cf cli search "list D1 databases"
cf cli search "inspect Worker deployments"
cf cli search "inspect Artifacts repositories"
```

Expected result for --version: a supported version recorded in the toolchain. Expected whoami result: valid authentication and the confirmed account ID. Search queries contain no account name, ID, domain, email or token. Search results are discovery, not qualification evidence.

After discovering a command, inspect that command's --help and its cf schema equivalent to determine exact account flags, request fields and output. Pin the account before invoking an account-scoped read or mutation; do not rely on interactive selection or directory caches. Review scopes without printing credential material.

## Prerequisites and qualification

Verify separate Alchemy credentials against the explicit account. cf and its delegated tooling do not share all credential stores automatically. Keep secrets outside documentation and retained command argv/logs. Service availability must be measured with read/qualification calls, not inferred from a broad OAuth scope or an API command's existence.

P0 staging qualification uses only gitfoundry-owned resources and scoped test identities. Inspect existing resources first; do not rename/delete/adopt unrelated account resources. Establish the protected application routes, repository publication boundary, isolated execution profiles, observability and restore path. Record provider/account/runtime/resource revisions with redacted receipts.

## Rollout and recovery

Publish through Alchemy to staging. Verify the exact Worker versions, bindings, migrations and container profile, then run authenticated positive/negative flows. Production uses separate state and the same verified revision. Use expand/contract migrations, retain old-compatible readers during rollout, and inspect drift before promotion.

After a failed canary, restore the previously accepted deployment through Alchemy without losing accepted Git refs or collaboration records. Reconcile unknown provider writes before retrying. Prove backup/restore and rollback in staging before production launch. Never treat a CLI exit zero as proof of the desired persisted state.

## Official command references

The baseline was checked against [cf getting started and authentication](https://developers.cloudflare.com/cf/get-started/) and [cf project behavior](https://developers.cloudflare.com/cf/projects/). Recheck official docs and the installed command schema during P0 because cf is beta. [The Cloudflare CLI entry point](https://developers.cloudflare.com/cf/) provides command documentation.

tl;dr: Pin the confirmed account and let Alchemy own infrastructure. Use cf for discovered, explicitly targeted inspection and operations, with real-state verification and separate credentials.
