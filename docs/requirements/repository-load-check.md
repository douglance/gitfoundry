# Repository load check

## Stakeholder need

The GitFoundry owner needs every production release to prove that the canonical repository loads, so that a signed-in person never meets a repository page that cannot show its code, forks, or issues.

## Problem statement

On October 11, 2026, after signing in at https://gitfoundry.dev, the owner's repository page showed "Source unavailable" with `gfy_git_reference_unavailable` and "Unable to load issues" with `fork_backend_unavailable`. The live API log recorded only `gitfoundry.forge.backend_unavailable` with code `trusted_execution_failed` for the head and list actions, and nothing for the source read. Release qualification passed, because it checks the container image and the Artifacts provider but never loads a repository.

## Requirements

- R1: The operator repository check shall read the canonical repository's head version through the forge.
- R2: The operator repository check shall list the canonical repository's versions through the forge.
- R3: The operator repository check shall read the source tree at the head version's code commit.
- R4: When a stage of the operator repository check fails, the check shall respond with status 503, the failing stage's name, and the failure's cause.
- R5: The operator repository check shall reject requests that carry no operator credential.
- R6: A release shall fail when the operator repository check does not respond with status 200.
- R7: When the forge helper fails, the forge failure log entry shall include the helper's response status, receipt status, exit code, or error message.

## Acceptance criteria

### R1, R2, R3: Repository loads

Given a canonical repository whose forge head and source tree are readable

When the operator check runs with a valid operator credential

Then the response has status 200 and names the head version commit, the number of listed versions, and the number of tree entries.

### R4: Failing stage is named

Given a forge helper that responds with status 500 and error `gfy_linux_container_start_failed`

When the operator check runs

Then the response has status 503, stage `head`, and a cause containing `500` and `gfy_linux_container_start_failed`.

Given a forge head that is readable and a source read that fails as `unsupported` with reason `provider tree capability unavailable`

When the operator check runs

Then the response has status 503, stage `tree`, and a cause containing `unsupported` and `provider tree capability unavailable`.

### R5: Operator only

Given a request with no operator credential

When it reaches the operator check

Then the response has status 401 and no forge read happens.

### R6: Release gate

Given the operator check responds with status 503

When the release qualifies the deployment

Then the release fails with a message naming the failing stage.

### R7: Helper failure is logged

Given a forge helper receipt with status `failed` and exit code 128

When a workspace forge head request runs

Then the failure log entry includes `failed` and `128`.
