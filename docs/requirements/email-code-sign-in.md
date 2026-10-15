# Email-code sign-in

## Stakeholder need

People who use GitFoundry need to sign in on a GitFoundry page with a code sent to their email, so that customers sign in through GitFoundry instead of a third-party login page.

## Problem statement

Opening https://gitfoundry.dev on October 11, 2026 redirected to `solitary-poetry-b5fd.cloudflareaccess.com`, a Cloudflare Access page titled "Log in to gitfoundry-Access-production-xjhw4jdxgc4tffcp". GitFoundry has no sign-in page, no sign-in email, and no sign-up: the API accepts only Cloudflare Access tokens, and only the configured owner email reaches a workspace. The owner judged this page unfit for customers.

## Requirements

- R1: When a person submits an email address on the GitFoundry sign-in page, GitFoundry shall send that address an email from `login@gitfoundry.dev` containing a six-digit sign-in code.
- R2: GitFoundry shall accept a sign-in code only for the email address it was sent to, only within 10 minutes of sending, and only once.
- R3: GitFoundry shall reject further attempts at a sign-in code after five incorrect codes for it.
- R4: When a person signs in with an email address that has no GitFoundry account, GitFoundry shall create an account and a new workspace that the person owns.
- R5: When the configured owner email signs in, GitFoundry shall sign the person in to the existing owner workspace.
- R6: A successful sign-in shall keep the person signed in for 30 days unless the person signs out.
- R7: After a person signs out, GitFoundry shall reject requests carrying that person's previous sign-in.
- R8: GitFoundry shall reject workspace requests that carry no sign-in, an expired sign-in, or a sign-in for a different workspace.
- R9: The response to a submitted email address shall be identical whether or not an account exists for it.
- R10: GitFoundry shall send at most five sign-in emails per email address per hour.
- R11: GitFoundry shall serve its web page to a visitor without a sign-in, with no workspace selected.
- R12: GitFoundry shall serve its web page to a signed-in person with that person's workspace selected.
- R13: When a command-line or agent client verifies a sign-in code, GitFoundry shall return the sign-in token in the response body instead of a browser cookie.
- R14: GitFoundry shall accept a sign-in token sent as an `Authorization: Bearer` header wherever it accepts the browser sign-in cookie.
- R15: GitFoundry shall reject requests carrying a Cloudflare Access user token in place of a sign-in.

## Acceptance criteria

### R1: Code email sent

Given the sign-in page

When a person submits `new@example.com`

Then one email to `new@example.com` from `login@gitfoundry.dev` contains a six-digit code.

### R2: Code bound to address, lifetime, and single use

Given a code sent to `new@example.com`

When the code is submitted for `other@example.com`, or 10 minutes and 1 second after sending, or a second time after a successful sign-in

Then each submission is rejected and no sign-in is issued.

### R3: Attempt limit

Given a code sent to `new@example.com`

When five incorrect codes are submitted and then the correct code is submitted

Then the correct code is rejected.

### R4: Open sign-up

Given no account for `new@example.com`

When the person submits the correct code

Then the person is signed in, a new workspace exists, and the person can list that workspace's repositories.

### R5: Owner keeps the owner workspace

Given the configured owner email `doug.lance@gmail.com`

When the owner signs in with a correct code

Then the owner can list repositories in the `owner` workspace and no new workspace is created.

### R6: Sign-in lifetime

Given a successful sign-in

When the person makes a workspace request 29 days later, and again 30 days and 1 second later

Then the first request succeeds and the second is rejected.

### R7: Sign out

Given a signed-in person

When the person signs out and a request is then made with the previous sign-in

Then the request is rejected.

### R8: Workspace isolation

Given two signed-up people with separate workspaces

When the first person requests the second person's workspace, and when a request carries no sign-in

Then both requests are rejected.

### R9: No account enumeration

Given an existing account for `doug.lance@gmail.com` and no account for `new@example.com`

When each address is submitted

Then both responses have the same status and body.

### R10: Email rate limit

Given five sign-in emails sent to `new@example.com` within one hour

When a sixth is requested within that hour

Then no sixth email is sent.

### R11: Signed-out visitors reach the sign-in page

Given a visitor with no sign-in and no Cloudflare Access token

When the visitor opens `/`

Then the response is the web page with status 200 and an empty starting workspace.

### R12: Signed-in people land in their workspace

Given a person signed in to workspace `W`

When the person opens `/`

Then the web page's starting workspace is `W`.

### R13: Token for command-line clients

Given a code sent to `new@example.com`

When the code is verified with `client` set to `cli`

Then the response has status 200, carries a `session_token` starting with `gfys_`, and sets no cookie.

### R14: Bearer sign-in

Given a sign-in token from R13

When it is sent as `Authorization: Bearer` to list the workspace's repositories, and again after signing out with the same header

Then the first request succeeds and the second is rejected with status 401.

### R15: No Cloudflare Access user tokens

Given a valid Cloudflare Access token for the configured owner

When it is sent as `Authorization: Bearer` to list the owner workspace's repositories

Then the request is rejected with status 401.

## Scope exclusions

Invitations to a shared workspace, and retiring Cloudflare Access for the operator and runner service paths, are later increments.
