# Fork forge contract

This is the canonical product contract for the first build.

## Claim

**The forge lives in the repository.** A complete Git mirror contains the code and durable collaboration history needed to reconstruct the forge and resume checkpointed work. Credentials, account authentication, live processes and uncommitted changes are outside that claim. Indexes and caches must be rebuildable from Git.

## Primitive

The primitive is a versioned file tree changed through commits and published through conditional ref updates.

| Operation | Contract |
|---|---|
| Read | Read files at an exact commit. |
| Fork | Create a complete child forge from known descriptor parents. |
| Commit | Apply file changes against an expected descriptor/head; reject stale updates. |
| Compare | Inspect differences between exact descriptor or tree revisions. |
| Merge | Produce a candidate descriptor or explicit conflicts while preserving inputs. |
| Publish | Advance `refs/heads/forge-head` only from the expected descriptor to the verified descriptor. |

## Bootstrap baseline

`forge.initialize` accepts exactly one bootstrap source: an existing immutable `code_commit`, or `initial_code` as ordinary file changes with `path`, `content_base64`, and optional `mode` (`100644`, `100755`, or `120000`). `initial_state` is optional and uses the same ordinary file-change shape for forge-state documents. The service writes the initial code commit when `initial_code` is supplied, writes the baseline forge-state commit, creates the first descriptor, and publishes it with the same authenticated and idempotent primitive used by every other fork operation.

This is a bootstrap primitive for empty Artifacts repositories. It does not introduce a workflow engine, scheduler, pull request object, or special orchestration path.

## Exact reads

`forge.read` always names an exact descriptor version and a tree, `code` or `state`. Supplying `path` returns that file as base64. Omitting `path` returns exact tree entries, optionally filtered by `prefix`, so interfaces can reconstruct document panels without bulk-loading every fork document.

## Complete forge fork

Every published change is a child fork of the complete forge. A fork includes code repository content, forge application source, collaboration documents, agent and evaluator documents, and safe configuration. A descriptor commit is immutable and contains `fork_id`, parent descriptor SHAs, exact code SHA and state SHA, authenticated creator identity and actor kind, operation ID, and digest.

Retained refs pin descriptor/code/state revisions. Aliases such as `main` and `forge-state` may be repaired from descriptors; they are not authoritative.

## Publication authority

`refs/heads/forge-head` is the sole authoritative expected-OID compare-and-swap publication ref. The trusted service records an acceptance intent, verifies evidence, performs the conditional ref update, then records completion. The candidate's durable intent binds its winning operation ID. Head acceptance and receipt completion use separate single-ref updates; the next publication reconciles its predecessor's receipt before advancing. Restart reconciles unfinished intents against actual refs. Code and state aliases are rebuilt from the current authoritative head. Multi-ref atomic Git pushes are not required. Publication fails closed when evidence verification is missing.

## Protected publication configuration

`config/publication.json`, `config/evaluator.json`, and `config/trusted-keys.json` are protected state records. Publishing changes to them must preserve the currently accepted code commit. Configuration publication requires at least one signed human approval, or more when the current policy requires more reviewers. A code change and a policy change cannot be accepted together.

Create an ordinary state-only fork, then commit an unsigned review with `kind: "review"`, `decision: "approve"`, `configuration_review: true`, a stable `id`, and a nonempty `reason`. The authenticated signing service binds the review to the canonical expected descriptor and the exact contents of all three protected files. Publish that reviewed fork against the same expected descriptor. Tampering with a record, changing the target, or substituting an agent approval invalidates the authorization.

This metadata operation leaves accepted code unchanged. Code publication still requires checks and reviews for its exact SHA under the accepted policy. Changing the evaluator requires reviewing the new evaluator configuration before its evidence can authorize a code change.

## Collaboration records

Issues, reviews, assignments, dependencies, checkpoints and check results are JSON or Markdown files. Each record has its own stable identifier and file. Approving a code SHA does not mutate that SHA; the approval is state that names the exact candidate revision.

## Interfaces

The same contract backs web UI, `gfy`, Incurs CLI, local MCP, Cloudflare remote MCP, and caller-authored agent compositions such as autoresearch fanout and merge chains. GitFoundry provides the primitive and safety boundaries. It does not hardcode a scheduler, workflow language or goal engine.

tl;dr: The first product is a fork-first Git primitive, not a workflow engine. Complete forge forks, immutable descriptors and `forge-head` CAS are the durable coordination model.
