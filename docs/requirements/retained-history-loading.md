# Retained forge history loading

## Stakeholder need

A developer needs to open Forge after repeated development runs without waiting past the native client's request deadline.

## Problem statement

On October 11, 2026, the native repository's forks request remained pending after 30 seconds in the browser. The native CLI request failed after 10.07 seconds with HTTP_REQUEST_FAILED. The history reader awaits each retained version serially.

## Requirements

- R1: Forge shall return the complete authenticated retained history within 10 seconds when listing 81 retained versions with each Git request taking 40 milliseconds.
- R2: Forge shall reject a history containing a version whose retained code reference differs from its descriptor.

## Dependencies

None.

## Acceptance criteria

Given 81 retained versions and a Git command latency of 40 milliseconds.

When the developer lists Forge history.

Then the complete versions appear within 10 seconds in retained-reference order.

Given a retained version with a mismatched code reference.

When the developer lists Forge history, Then the request fails with an authentication error.
