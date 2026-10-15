# Changing GitFoundry inside GitFoundry

An agent changes GitFoundry the same way it changes any repository here.

1. Fork the published version. Never edit the published head.
2. Commit the change to the fork.
3. Ask the runner for an `all-tests` run on that exact version.
4. Publish the version that carries the runner's signed result, with the head you forked from as the expected head.

The publishing rules need no person: a passing signed `all-tests` result is enough.
If the run fails, nothing is published. Read the result, fix the fork, and run it again.
If someone published first, fork the new head and start again.

Rules changes follow the same path, with one exception: a change to the trusted keys
always needs the owner's signed review, and a rules change never carries code in the same publish.

`scripts/self-improve.mjs` runs these steps:

    node scripts/self-improve.mjs --change path=local-file --why "what and why"
