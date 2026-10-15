# Staging infrastructure

Alchemy owns resource creation, bindings, D1 migrations, and Worker publication.
The stack entrypoint is `apps/api-worker/alchemy.run.ts`; it resolves the pinned
Alchemy dependency from that package. It declares the API and Rust MCP Workers,
one shared Access application, D1, an artifact bucket, the Code Mode Durable
Object, and its Worker Loader binding.

The first migration preserves the normative 52-table SQL contract. The imported
source remains immutable. Later schema changes require separate migrations.

Run from `apps/api-worker` with the isolated Alchemy home and `gitfoundry-staging`
profile, the `staging` stage, confirmed account ID, explicit owner email, and
verified Access issuer. Build the Rust Worker bundle first. Plan and inspect the
resource graph before deployment. Neither this file nor a successful plan proves
authentication, Git protection, Linux execution, or product acceptance.

```text
before
+------------------------+
| Local API / MCP code   |
+------------------------+

after deployment
+------------------------+
| Shared Cloudflare      |
| Access application     |
+-----------+------------+
            |
            v
+------------------------+
| API Worker + D1        |
+-----------+------------+
            ^
            | private named service binding
+-----------+------------+
| Rust MCP Worker        |
+-----------+------------+
            |
            v
+------------------------+
| Code Mode DO + Loader  |
+------------------------+
```

tl;dr: Alchemy declares the staging resources from one graph. Deployment and live acceptance remain separate gates.
