# Current requirements

Version: fork-first planning baseline, October 9, 2026. Status: requirements finalized for the first implementation; Cloudflare deployment and scenario evidence are pending.

## Product outcome

GitFoundry must prove one claim: **The forge lives in the repository.** A complete Git mirror must contain the code and durable collaboration history needed to reconstruct the forge and resume checkpointed work. Credentials, account authentication, live processes and uncommitted changes are outside that claim.

## Current requirement register

| ID | Requirement | Acceptance evidence |
|---|---|---|
| FF-001 | Implement read, fork, commit, compare, merge and publish by conditional ref update. | API/CLI/MCP tests cover success, stale and conflict cases against exact SHAs. |
| FF-002 | Represent every proposed change as a complete forge fork. | Descriptor inspection shows code, state, config, agent and evaluator roots. |
| FF-003 | Store immutable descriptor commits with `fork_id`, parents, exact roots, actor, operation ID and digest. | Corrupt descriptor, duplicate operation and stale parent tests fail safely. |
| FF-004 | Store collaboration as JSON/Markdown files with stable IDs. | Concurrent unrelated record updates can retry; same-record conflicts are explicit. |
| FF-005 | Accept only exact verified candidates and advance `forge-head` only while evidence remains valid. | Stale approval, missing evidence, changed target and duplicate publish tests block or reconcile correctly. |
| FF-006 | Expose the same protocol to web, `gfy`, local MCP and Cloudflare MCP. | One operation catalog drives all interfaces; no interface-only mutation path exists. |
| FF-007 | Run on Cloudflare without adding product scope in account `88f9cbf5c4f4e217079bcbf0ca6cb181`. | Cloudflare deployment inventory, Artifacts write/CAS proof and D1/cache rebuild proof. |
| FF-008 | Preserve the simple forge interface while replacing pull-request language with forks, lineage, exact revisions, evidence and inspectable records. | Rendered UI shows fork lineage and Inspect underlying record. |
| FF-009 | Demonstrate concurrent integration, interrupted handoff and fresh reconstruction. | Repeated scenario runs include exact revisions, failures, recovery and measured interventions. |
| FF-010 | Keep owner-only tasks separate from engineering work. | TODOUG contains only eligibility, contact, attendee, optional domain/IdP and manual submission actions. |

## Historical requirement mapping

The archived handbook and handoff remain under [source](source). [requirements-trace.csv](requirements-trace.csv) preserves all 80 historical requirement rows and maps each one as `retained`, `superseded` or `deferred`. The 198 archived operation contracts are source evidence only. They are not advertised as implemented product coverage for the first build.

## Non-requirements

No native desktop/mobile/watch app is required. No pull-request compatibility layer is required. No generic scheduler, workflow language, autonomous conflict solver, enterprise migration suite or large-scale compute claim is required.

tl;dr: The first requirements are the fork primitive, complete forge forks, immutable descriptors, exact verified publication and three repeatable scenario proofs. The old 80/198 inventories are preserved as mapped source inputs, not as readiness gates.
