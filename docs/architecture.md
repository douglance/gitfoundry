# Architecture and trust boundaries

The architecture is a fork-first Git system on Cloudflare.

## System flow

```text
  human/gfy/MCP/agent
          │ shared protocol
          ▼
  Workers: auth, validation, UI/API, evidence checks
          │ scoped repository credentials
          ▼
  Artifacts: complete forks, descriptors, retained refs
          │ derived indexes only
          ▼
  D1/cache: rebuildable from Git
```

## Authoritative state

Descriptor commits define complete forge forks; retained refs pin descriptors/code/state; `refs/heads/forge-head` is the only publication head; state aliases are repairable and never assumed atomic with code refs. Credentials are outside Git portability.

## Component responsibilities

Workers enforce UI/API/auth/validation/evidence; Artifacts stores complete forks and refs; Incurs/`gfy`, local MCP and Cloudflare MCP expose the same protocol; agent/test runners execute caller-authored compositions; D1/cache holds derived indexes or operation-intent recovery; Alchemy owns Cloudflare resources.

## UI model

Keep the existing forge interface, but surface forks and records: repository overview, issue/assignment, branch/fork, comparison, review/check, history, setup and Inspect underlying record.

## Cloudflare compatibility risk

Artifacts write and credential features must be verified before product claims. If credentials cannot restrict canonical writes sufficiently, agents receive separate Artifacts forks and the trusted Worker imports accepted commits into canonical retained refs.

tl;dr: Workers enforce trust; Artifacts stores complete forks; `forge-head` is the only publication head; D1/cache are derived or recovery support. Agents compose the same protocol through web, gfy, local MCP and Cloudflare MCP.
