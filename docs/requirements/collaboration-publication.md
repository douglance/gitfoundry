# Collaboration-only publication

## Stakeholder need

GitFoundry developers need to add issues and comments while code checks are pending.

## Problem statement

Publishing a retained version that only adds an issue to the accepted code returned HTTP 503 with `fork_backend_unavailable` on the local GitFoundry instance. The retained issue version is `97479ba17f792577c8f1a512daaa4d4789930cfe`; its code commit equals the authoritative version's code commit. The publication verifier currently requires code check receipts for every publication.

## Requirements

- R1: When code is unchanged and the only state changes add, edit, or delete regular files named `issues/ID.json` or `comments/ID.json`, GitFoundry shall permit publication without code check receipts or code review approvals. `ID` is 1 to 128 ASCII letters, digits, periods, underscores, or hyphens, beginning with a letter or digit.
- R2: For a candidate that changes code or a state file outside R1, GitFoundry shall reject publication when the candidate has no check receipts and no review approvals.
- R3: For a publication whose expected head differs from the authoritative head, GitFoundry shall reject the publication without changing the authoritative head.

## Acceptance criteria

### R1: Publish collaboration state while code acceptance is absent

Given an initialized repository with required code checks and reviews but no receipts

When a developer adds an issue, edits it, adds a comment, or deletes that comment without changing code or other state files

Then each publication succeeds and the published code commit remains the initial code commit.

### R2: Reject an attempted evidence bypass

Given the same repository without receipts

When a candidate changes code, a check record, a review record, an unknown state file, or an issue path to a symbolic link

Then publication fails and the authoritative head remains unchanged.

### R3: Reject a stale collaboration publication

Given two collaboration candidates based on the same head and the first already published

When the second publishes with the original expected head

Then it fails and the first remains authoritative.

## Diagnostic hypotheses

1. Code evidence is required for collaboration-only state: publishing the retained issue with unchanged code returns an evidence error.
2. The owner cannot publish: a publication authorization error would occur before evidence verification.
3. The candidate is stale: a head conflict would report a different authoritative version.

The unchanged authoritative head and verifier's unconditional required-check loop support the first hypothesis. The acceptance test will exercise publication with real Git objects rather than a mocked internal component.
