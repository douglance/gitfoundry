# GitFoundry

GitFoundry is a forge where every change is a fork, and the forge is the agent harness.

Teams that run coding agents usually build two things: the agents, and a harness that hands out work, keeps context, collects reviews, runs checks and decides what is done. GitFoundry puts that harness in the forge. Each agent works in its own complete fork. A fork carries the code plus a state tree with the agent's handoff notes, reviews and checks. One pointer, the forge head, decides what is published, and it moves only when nobody moved it first.

Try it live at **https://gitfoundry.dev**. Sign in with any email to get a workspace.

## Run the multi-agent demo

You need Node.js 22 or later.

```bash
git clone https://github.com/douglance/gitfoundry.git
cd gitfoundry
node scripts/agents-demo-setup.mjs you@example.com   # emails you a sign-in code and creates a demo repository
node scripts/agents-demo.mjs
```

Three agents fork the same head at once and each commit a change to one checkout file. An integrator merges them. Two agents rewrote the same function, so the merge returns the exact conflicting file and the agent resolves it on top of the integration line. The tests run on the exact merged code, and passing tests publish it with no person approving. A late agent then tries to publish from the old head and is refused. Every attempt is kept.

Open the printed link and choose **Forge** to see the lineage.

## How it works

- **Every change is a fork.** A fork holds the code, the forge app source, collaboration records, configuration and agent documents.
- **Context travels with the work.** Handoff notes, reviews and check results live in the fork's state tree, so a fresh agent or a person picks up where the work stopped.
- **Merges return work, not failures.** A merge returns a new fork or the exact conflicting files.
- **Publishing is a compare-and-swap.** The forge head moves only from the head the caller expected. A stale publish is refused, and nothing is overwritten.
- **Rules live in Git.** Each repository's publishing rules can require a signed review, or let a passing signed test run publish on its own.
- **The forge builds itself.** GitFoundry's own repository lives in GitFoundry. An agent changes its instructions and code in a fork, the runner tests that exact version and signs the result, and the change publishes when the tests pass. See [docs/agents/forge.md](docs/agents/forge.md).

There are no pull-request objects. Review, approval, checks and handoff are documents inside forks.

## Connect an agent

The same emailed sign-in code works in the browser, in the `gfy` command line and in any MCP client, so an agent can fork, commit, merge and publish alongside you.

## Built on Cloudflare

Workers serve the web app, the forge API, MCP tools and email sign-in. Every repository and fork is stored in Artifacts. Writes build Git objects in the Worker and push them to Artifacts, using the atomic ref update as the compare-and-swap, so concurrent agents write in parallel. D1 holds accounts, sessions and check history. Containers with Durable Objects run a Git helper for line-level merges and an isolated test runner. A Cron Trigger checks production every five minutes and shows the results on the Status page.

## Develop locally

```bash
./gfy local serve
# In another terminal:
./gfy local import --source-path "$PWD"
./gfy forge head --tenant-id local --repository-id gitfoundry
./gfy local run --version-commit VERSION --argv-json '["node","scripts/test-all.mjs"]'
```

Further reading: [fork forge contract](docs/fork-forge-contract.md), [requirements](docs/requirements.md), [architecture](docs/architecture.md) and [acceptance](docs/acceptance.md).

## License

[MIT](LICENSE)
