# Approved product decisions

Baseline: October 9, 2026. These decisions supersede earlier enterprise-forge and pull-request-oriented planning where they conflict. Implementation remains incomplete unless an evidence document says otherwise.

## Document authority

The current authority order is: user direction in the active thread, this decision register, [fork forge contract](fork-forge-contract.md), current requirements, then archived PDF/handoff sources. Archived sources remain preserved and traced; they are not independent scope gates.

## Decision register

| ID | Decision | Consequence |
|---|---|---|
| DEC-001 | Product claim: **The forge lives in the repository.** | Durable collaboration state is Git data. Caches and indexes are rebuildable. Credentials and live processes remain outside Git. |
| DEC-002 | Every change is a complete forge fork. | Code, forge app source, collaboration records, config, agent records and evaluator evidence move together through fork descriptors. |
| DEC-003 | `refs/heads/forge-head` is the authoritative publication ref. | Main and forge-state are derived aliases. Publication uses expected-OID CAS and retained refs. |
| DEC-004 | There are no pull-request objects in the primitive. | Reviews, approvals, checks and handoffs are documents naming exact revisions. |
| DEC-005 | Caller workflows compose the primitive. | Autoresearch fanout, merge chains and handoff are examples authored by callers or agents. GitFoundry does not ship a scheduler, goal engine or workflow language now. |
| DEC-006 | Cloudflare implements the product without expanding it. | Workers provide UI/API/auth/validation; Artifacts provides repositories; D1/cache are derived or coordination support; Alchemy owns infra. |
| DEC-007 | Agents cannot publish directly to canonical `forge-head`. | They work in isolated Artifacts repos/forks. A trusted service imports and conditionally publishes verified descriptors. |
| DEC-008 | Incurs/`gfy`, local MCP and Cloudflare remote MCP use the same public protocol. | Agentic interfaces are first-class, but they do not receive a separate product model. |
| DEC-009 | Kumo/Pierre UI choices are retained only as presentation choices. | Existing forge UI is preserved and renamed around forks, lineage, exact revisions and inspectable records. |
| DEC-010 | Competition evidence is scenario-based. | Required demonstrations are concurrent integration, interrupted handoff and fresh reconstruction from a complete Git mirror. |
| DEC-011 | Historical 80 requirements and 198 operations are archive inputs. | They are mapped as retained/superseded/deferred. They are not product readiness gates for the first build. |

## Naming

Keep the project repository name `gitgood`. Use GitFoundry for the product and `gfy` for the CLI/API namespace. Avoid new names until after the competition submission.

tl;dr: GitFoundry is now fork-first: complete forge forks, descriptor commits and `forge-head` CAS define the product. Previous PR/workflow/enterprise parity scope is retained only as archived input or future work.
