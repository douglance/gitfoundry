# Acceptance and evidence

Acceptance is exact-revision evidence, not a readiness assertion.

## Current evidence

Local API-worker and integrated workspace checks are green through root evidence `01a12076-88e3-7b32-8ba6-e8ca37007945`. This proves local code state only. It does not prove Cloudflare deployment, Artifacts behavior, scenario success or competition readiness.

## Acceptance boundary

Assemble candidate C, run checks against C, record review decisions against C, reauthenticate the actor, verify evidence for C, advance `refs/heads/forge-head` from expected H to C by CAS, record completion and reconcile unfinished intents after restart. If H changes, construct and verify a new candidate.

## Required scenario evidence

Concurrent integration, interrupted handoff and forge reconstruction must each run with actual-agent evidence. Stale write, same-record contention, textual conflict, clean merge failing a behavior check, duplicate request, missing evidence verifier, stale approval and agent interruption must each fail or recover safely with exact revisions recorded.

## Evidence envelope

Every claim must include revision or descriptor SHA, environment, command or scenario run ID, timestamp, actor identity kind, verdict and artifact link/path.

## Non-acceptance

Generated UI images, mocked Git state, hardcoded scripts that bypass the public primitive, local-only fixtures, green focused tests alone and archived source validation do not establish product acceptance.

tl;dr: Acceptance means exact candidate evidence survives conflict, interruption, stale writes and reconstruction. Local green checks are useful, but Cloudflare and scenario proof remain required.
