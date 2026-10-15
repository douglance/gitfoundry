# Live site checks

## Stakeholder need

The GitFoundry owner needs production to check itself on a schedule and show the results in the site, so that a broken repository page is seen within minutes instead of when a person meets it.

## Problem statement

On October 11, 2026, the owner's repository page at https://gitfoundry.dev showed "Source unavailable" and "Unable to load issues" after a release whose qualification had passed. The repository load check added afterwards runs only during a release. Between releases nothing reads the canonical repository, and the site has no view that says whether production currently works.

## Requirements

- R1: Every 5 minutes, production shall run the repository load check against the canonical repository.
- R2: Each scheduled check shall record its time, its outcome, its duration, and, for a failure, the failing stage and the failure code.
- R3: The site checks list shall return the 50 newest recorded checks, newest first.
- R4: The site checks list shall reject a request that carries no session with status 401.
- R5: The site checks list shall reject a session from a workspace other than the owner workspace with status 403.
- R6: The status view shall show whether the newest check passed, when it ran, and the recorded checks.
- R7: The status view shall refresh the recorded checks every 30 seconds while it is open.
- R8: Recorded checks older than 7 days shall be deleted when a scheduled check is recorded.

## Acceptance criteria

### R1, R2: Scheduled check is recorded

Given a canonical repository whose head, versions, and source tree are readable

When the scheduled check runs at 2026-10-12T18:00:00Z

Then one recorded check exists with time 2026-10-12T18:00:00Z, outcome passed, and a duration of zero or more milliseconds.

Given a canonical repository whose source tree read fails as `unsupported`

When the scheduled check runs

Then the recorded check has outcome failed, stage `tree`, and code `unsupported`.

### R3: Newest first, at most 50

Given 60 recorded checks

When the owner requests the site checks list

Then the response has status 200 and holds 50 checks, the first being the newest.

### R4: No session

Given a request without a session

When it requests the site checks list

Then the response has status 401.

### R5: Other workspace

Given a session for a workspace other than the owner workspace

When it requests the site checks list

Then the response has status 403.

### R6, R7: Status view

Given the owner is signed in and the newest recorded check passed

When the owner opens the status view

Then the view says "All checks passing", shows the time of the newest check, and lists the recorded checks, and 30 seconds later it requests the list again.

Given the newest recorded check failed at stage `tree`

When the owner opens the status view

Then the view says "Failing" and names stage `tree`.

### R8: Old checks are removed

Given a recorded check from 2026-10-01T00:00:00Z

When the scheduled check runs at 2026-10-12T18:00:00Z

Then the check from 2026-10-01 no longer exists.
