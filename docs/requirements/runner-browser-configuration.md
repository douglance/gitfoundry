# Native runner browser configuration

## Stakeholder need

A developer needs a native local job to use the browser configured for its host.

## Problem statement

The complete persistent browser workflow passed fifteen cases with an installed Chrome for Testing binary. Ordinary Chrome exited while displaying only about:blank before thirty seconds. The native local runner's environment list omits CHROME_BIN, preventing a configured browser from reaching its child process.

Evidence: dogfood-browser-testing-binary-20261011 and dogfood-blank-browser-lifetime-20261011.

## Requirements

- R1: The native local runner shall set a child process's CHROME_BIN environment variable to the parent's configured nonempty string value.

## Acceptance criteria

### R1: Preserve the configured browser

Given the parent has CHROME_BIN set to a nonempty configured string

When the native local runner starts a child process

Then the child observes that exact string.

### R1: Preserve absence of browser configuration

Given the parent has no CHROME_BIN variable

When the native local runner starts a child process

Then the child has no CHROME_BIN variable.
