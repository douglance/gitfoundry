# Workspace load

## Stakeholder need

A signed-in person needs the workspace to finish loading in a few seconds and to show true counts for every section, so that they can trust what the sidebar and footer say.

## Problem statement

On October 12, 2026, the owner workspace at https://gitfoundry.dev showed "Loading workspace" in the footer for about 15 seconds after sign-in. The browser sent three separate forge head reads for the one repository, one each for issues, reviews, and checks, taking 3.2, 4.7, and 7.1 seconds. A single head read took 2.6 seconds when measured alone. The sidebar showed "—" beside Forge at all times, and the workspace Forge view said "No forge versions yet" while the repository held the forge version gitfoundry-main-14f1e5b-adopt-20261011-v1.

## Requirements

- R1: When issues, reviews, and checks load at the same time, the workspace shall send one forge head read for each repository.
- R2: The workspace forge list shall contain every forge version of every repository in the workspace.
- R3: Each entry in the workspace forge list shall name its repository and its fork.
- R4: When a repository's forge versions cannot be read, the workspace forge list shall fail with that repository's error.
- R5: The sidebar shall show the number of forge versions in the workspace beside Forge.

## Acceptance criteria

### R1: One head read per repository

Given a workspace with one repository whose forge head is readable

When issues, reviews, and checks are listed at the same time

Then exactly one forge head request reaches that repository.

### R2, R3: Workspace forge list

Given a workspace with repositories repo-a and repo-b, each holding one forge version

When the workspace forge list loads

Then it holds two entries, each with its repository identifier and its fork identifier as its title.

### R4: Failure is reported

Given a workspace whose repository answers the fork listing with status 503

When the workspace forge list loads

Then the result fails with status 503.

### R5: Sidebar count

Given the owner workspace with one repository holding one forge version

When a signed-in person opens the workspace

Then the sidebar shows 1 beside Forge.
