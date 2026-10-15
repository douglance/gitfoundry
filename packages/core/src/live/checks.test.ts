import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { decodeSourceSchema, type SourceDomainDocument } from "@gitfoundry/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DomainContractError, InvalidStateTransitionError, NotFoundError, StalePreconditionError, UnauthorizedError, type Actor } from "../index.js";
import type { CheckAnnotation, CheckCreateInput } from "../checks/index.js";
import { assertQualifiedSha } from "./forge.js";
import { makeD1CheckStore, type CandidateCheckQualificationPort } from "./checks.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  prepare(sql: string) {
    const database = this.db;
    type SqliteValue = string | number | bigint | null | Uint8Array;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values } },
      async first<T>() { return database.prepare(sql).get(...this.values as SqliteValue[]) as T | null },
      async all<T>() { return { results: database.prepare(sql).all(...this.values as SqliteValue[]) as T[] } },
      async run() { const result = database.prepare(sql).run(...this.values as SqliteValue[]); return { success: true, meta: { changes: Number(result.changes) } } }
    };
  }
}

const now = new Date("2026-10-08T00:00:00.000Z");
const clock = { now: () => now };
const actor: Actor = { id: "principal-a", tenantId: "tenant-a", revoked: false, capabilities: ["check.write", "check.read"] };
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const staleHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const baseSha = "cccccccccccccccccccccccccccccccccccccccc";
const executionSha = "dddddddddddddddddddddddddddddddddddddddd";
const sourceHeadSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const planDigest = "sha256:plan-fixture";
const policyDigest = "sha256:policy-fixture";

const gitRead = { resolveRef: ({ repositoryId, ref }: { readonly repositoryId: string; readonly ref: string }) => Effect.succeed(assertQualifiedSha(ref, repositoryId, ref)) };

const annotation = (overrides: Partial<CheckAnnotation> = {}): CheckAnnotation => ({
  path: "src/main.ts",
  start_line: 1,
  end_line: 1,
  start_column: null,
  end_column: null,
  level: "notice",
  message: "ok",
  title: null,
  raw_details: null,
  ...overrides
});

const createExternal = (overrides: Partial<CheckCreateInput> = {}): CheckCreateInput => ({
  repository_id: "repo-a",
  commit_sha: headSha,
  head_sha: headSha,
  base_sha: null,
  execution_sha: null,
  plan_digest: null,
  policy_digest: null,
  job_attempt_id: null,
  evidence_kind: "external",
  candidate_bound: false,
  provider_evidence_ref: "provider/run/1",
  name: "ci/build",
  status: "in_progress",
  conclusion: null,
  details_url: "https://checks.example/run/1",
  output: { title: "build", summary: "running", text: null },
  annotations: [],
  ...overrides
});

type CandidateProof = {
  readonly tenantId: string;
  readonly targetRepositoryId: string;
  readonly sourceRepositoryId: string;
  readonly producerId: string;
  readonly context: string;
  readonly candidateSha: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly planDigest: string;
  readonly policyDigest: string;
  readonly eligibilityId: string;
  readonly prId: string;
  readonly evidenceKind: CheckCreateInput["evidence_kind"];
  readonly jobAttemptId: string | null;
  readonly providerEvidenceRef: string | null;
  readonly status: CheckCreateInput["status"];
  readonly conclusion: CheckCreateInput["conclusion"];
  readonly writeFence: { readonly sql: string; readonly bindings: readonly (string | number | null)[] };
};

const createCandidateFixture = (overrides: Partial<CheckCreateInput> = {}): CheckCreateInput => createExternal({
  commit_sha: executionSha,
  head_sha: sourceHeadSha,
  base_sha: baseSha,
  execution_sha: executionSha,
  plan_digest: planDigest,
  policy_digest: policyDigest,
  candidate_bound: true,
  provider_evidence_ref: "provider/candidate-fixture",
  ...overrides
});

const trustedCandidateProofFixture = (overrides: Partial<CandidateProof> = {}): CandidateProof => ({
  tenantId: "tenant-a",
  targetRepositoryId: "repo-a",
  sourceRepositoryId: "repo-fork-fixture",
  producerId: "principal-a",
  context: "ci/build",
  candidateSha: executionSha,
  headSha: sourceHeadSha,
  baseSha,
  planDigest,
  policyDigest,
  eligibilityId: "eligibility-fixture",
  prId: "pr-a",
  evidenceKind: "external",
  jobAttemptId: null,
  providerEvidenceRef: "provider/candidate-fixture",
  status: "in_progress",
  conclusion: null,
  writeFence: { sql: "1", bindings: [] },
  ...overrides
});

const candidatePort = (proof: CandidateProof, calls: unknown[] = []): CandidateCheckQualificationPort => ({
  qualifyCandidateCheck: (request) => {
    calls.push(request);
    return Effect.succeed(proof);
  }
});

const countChecks = async (sql: SqliteD1): Promise<number> => (await sql.prepare("SELECT COUNT(*) AS count FROM checks").first<{ count: number }>())?.count ?? 0;

describe("D1-backed check live adapter", () => {
  it("evaluates the trusted candidate write fence after asynchronous qualification", async () => {
    const guard = { sql: "EXISTS (SELECT 1 FROM issues WHERE tenant_id = ? AND id = ? AND version = ?)", bindings: ["tenant-a", "pr-a", 1] };
    const createSql = fixture();
    const createPort: CandidateCheckQualificationPort = { qualifyCandidateCheck: () => Effect.sync(() => {
      createSql.db.prepare("UPDATE issues SET version = 2 WHERE tenant_id = ? AND id = ?").run("tenant-a", "pr-a");
      return { ...trustedCandidateProofFixture(), writeFence: guard };
    }) };
    const creating = makeD1CheckStore(createSql, { clock, candidateChecks: createPort });
    await expect(Effect.runPromise(creating.create("tenant-a", actor, createCandidateFixture()))).rejects.toBeInstanceOf(DomainContractError);
    expect(await countChecks(createSql)).toBe(0);

    const updateSql = fixture();
    const created = await Effect.runPromise(makeD1CheckStore(updateSql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()) }).create("tenant-a", actor, createCandidateFixture()));
    const updatePort: CandidateCheckQualificationPort = { qualifyCandidateCheck: () => Effect.sync(() => {
      updateSql.db.prepare("UPDATE issues SET version = 2 WHERE tenant_id = ? AND id = ?").run("tenant-a", "pr-a");
      return { ...trustedCandidateProofFixture({ status: "completed", conclusion: "success" }), writeFence: guard };
    }) };
    const updating = makeD1CheckStore(updateSql, { clock, candidateChecks: updatePort });
    await expect(Effect.runPromise(updating.update("tenant-a", created.id, actor, 1, { status: "completed", conclusion: "success" }))).rejects.toBeInstanceOf(StalePreconditionError);
    expect(await Effect.runPromise(updating.view("tenant-a", created.id))).toMatchObject({ version: 1, status: "in_progress", conclusion: null });
  });

  it("does not accept a competing writer's result as its own successful update", async () => {
    const sql = fixture();
    const created = await Effect.runPromise(makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()) }).create("tenant-a", actor, createCandidateFixture()));
    const qualifier: CandidateCheckQualificationPort = { qualifyCandidateCheck: () => Effect.sync(() => {
      const competitor = sql.db.prepare("UPDATE checks SET version = version + 1, status = 'completed', conclusion = 'failure' WHERE tenant_id = ? AND id = ? AND version = 1").run("tenant-a", created.id);
      expect(Number(competitor.changes)).toBe(1);
      return trustedCandidateProofFixture({ status: "completed", conclusion: "success" });
    }) };
    const store = makeD1CheckStore(sql, { clock, candidateChecks: qualifier });
    await expect(Effect.runPromise(store.update("tenant-a", created.id, actor, 1, { status: "completed", conclusion: "success" }))).rejects.toBeInstanceOf(StalePreconditionError);
    expect(await Effect.runPromise(store.view("tenant-a", created.id))).toMatchObject({ version: 2, status: "completed", conclusion: "failure" });
  });

  it("refuses writes when producer or tenant authority changes during qualification", async () => {
    const revocations = [
      "UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'",
      "UPDATE principals SET auth_epoch = auth_epoch + 1 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'",
      "UPDATE tenants SET state = 'suspended' WHERE id = 'tenant-a'",
      "UPDATE tenants SET policy_epoch = policy_epoch + 1 WHERE id = 'tenant-a'"
    ];
    for (const revocation of revocations) {
      const createSql = fixture();
      const createPort: CandidateCheckQualificationPort = { qualifyCandidateCheck: () => Effect.sync(() => {
        createSql.db.exec(revocation);
        return trustedCandidateProofFixture();
      }) };
      const creating = makeD1CheckStore(createSql, { clock, candidateChecks: createPort });
      await expect(Effect.runPromise(creating.create("tenant-a", actor, createCandidateFixture())), revocation).rejects.toBeInstanceOf(UnauthorizedError);
      expect(await countChecks(createSql), revocation).toBe(0);

      const updateSql = fixture();
      const created = await Effect.runPromise(makeD1CheckStore(updateSql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()) }).create("tenant-a", actor, createCandidateFixture()));
      const updatePort: CandidateCheckQualificationPort = { qualifyCandidateCheck: () => Effect.sync(() => {
        updateSql.db.exec(revocation);
        return trustedCandidateProofFixture({ status: "completed", conclusion: "success" });
      }) };
      const updating = makeD1CheckStore(updateSql, { clock, candidateChecks: updatePort });
      await expect(Effect.runPromise(updating.update("tenant-a", created.id, actor, 1, { status: "completed", conclusion: "success" })), revocation).rejects.toBeInstanceOf(UnauthorizedError);
      expect(await Effect.runPromise(updating.view("tenant-a", created.id)), revocation).toMatchObject({ version: 1, status: "in_progress", conclusion: null });
    }
  });

  it("refuses candidate result claims that do not match trusted execution evidence", async () => {
    const creationCases: readonly [string, Partial<CheckCreateInput>][] = [
      ["status", { status: "queued" }],
      ["conclusion", { status: "completed", conclusion: "success" }],
      ["provider evidence", { provider_evidence_ref: "provider/different-execution" }]
    ];
    for (const [label, input] of creationCases) {
      const sql = fixture();
      const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()) });
      await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture(input))), label).rejects.toBeInstanceOf(DomainContractError);
      expect(await countChecks(sql), label).toBe(0);
    }

    const sql = fixture();
    const created = await Effect.runPromise(makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()) }).create("tenant-a", actor, createCandidateFixture()));
    const updateProofs: readonly [string, CandidateProof][] = [
      ["still running", trustedCandidateProofFixture()],
      ["failed execution", trustedCandidateProofFixture({ status: "completed", conclusion: "failure" })],
      ["different provider execution", trustedCandidateProofFixture({ status: "completed", conclusion: "success", providerEvidenceRef: "provider/different-execution" })],
      ["different evidence kind", trustedCandidateProofFixture({ status: "completed", conclusion: "success", evidenceKind: "historical" })],
      ["different native attempt", trustedCandidateProofFixture({ status: "completed", conclusion: "success", jobAttemptId: "attempt-other" })]
    ];
    for (const [label, proof] of updateProofs) {
      const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(proof) });
      await expect(Effect.runPromise(store.update("tenant-a", created.id, actor, 1, { status: "completed", conclusion: "success" })), label).rejects.toBeInstanceOf(DomainContractError);
      expect(await Effect.runPromise(store.view("tenant-a", created.id)), label).toMatchObject({ version: 1, status: "in_progress", conclusion: null });
    }
  });

  it("refuses candidate updates when fresh qualification is absent or denied", async () => {
    const sql = fixture();
    const created = await Effect.runPromise(makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()) }).create("tenant-a", actor, createCandidateFixture()));
    const patch = { status: "completed" as const, conclusion: "success" as const };
    await expect(Effect.runPromise(makeD1CheckStore(sql, { clock }).update("tenant-a", created.id, actor, 1, patch))).rejects.toBeInstanceOf(DomainContractError);
    const denied: CandidateCheckQualificationPort = { qualifyCandidateCheck: () => Effect.fail(new DomainContractError({ message: "trusted execution did not report success" })) };
    await expect(Effect.runPromise(makeD1CheckStore(sql, { clock, candidateChecks: denied }).update("tenant-a", created.id, actor, 1, patch))).rejects.toBeInstanceOf(DomainContractError);
    expect(await Effect.runPromise(makeD1CheckStore(sql, { clock }).view("tenant-a", created.id))).toMatchObject({ version: 1, status: "in_progress", conclusion: null });
  });

  it("qualifies the complete next candidate check state before persisting an update", async () => {
    const sql = fixture();
    const calls: unknown[] = [];
    const qualifier: CandidateCheckQualificationPort = { qualifyCandidateCheck: (request) => {
      calls.push(request);
      return Effect.succeed(calls.length === 1 ? trustedCandidateProofFixture() : trustedCandidateProofFixture({ status: "completed", conclusion: "success" }));
    } };
    const store = makeD1CheckStore(sql, { clock, candidateChecks: qualifier });
    const created = await Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture()));
    const updated = await Effect.runPromise(store.update("tenant-a", created.id, actor, 1, { status: "completed", conclusion: "success", annotations_append: [annotation()] }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ tenantId: "tenant-a", producerId: "principal-a", targetRepositoryId: "repo-a", commitSha: executionSha, headSha: sourceHeadSha, baseSha, executionSha, planDigest, policyDigest, input: { status: "completed", conclusion: "success", annotations: [annotation()] } });
    expect(updated).toMatchObject({ version: 2, status: "completed", conclusion: "success" });
  });

  it("fails closed without a qualified git read port and rejects fabricated revisions", async () => {
    const sql = fixture();
    await expect(Effect.runPromise(makeD1CheckStore(sql, { clock }).create("tenant-a", actor, createExternal()))).rejects.toBeInstanceOf(DomainContractError);
    const store = makeD1CheckStore(sql, { clock, gitRead: { resolveRef: ({ repositoryId, ref }) => Effect.succeed(assertQualifiedSha(ref === headSha ? staleHeadSha : ref, repositoryId, ref)) } });
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal()))).rejects.toBeInstanceOf(DomainContractError);
  });

  it("creates lists and source-validates external check outputs with tenant and head filters", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, gitRead });
    const created = await Effect.runPromise(store.create("tenant-a", actor, createExternal()));
    expect(created).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", producer_id: "principal-a", status: "in_progress", version: 1 });
    decodeSourceSchema(await readDomain(), "Check", created);

    await seedCheck(sql.db, { id: "check-stale", commitSha: staleHeadSha, headSha: staleHeadSha, providerRef: "provider/stale" });
    await expect(Effect.runPromise(store.list("tenant-a", { repository_id: "repo-a", head_sha: headSha }))).resolves.toMatchObject({ items: [{ id: created.id }], has_more: false });
    await expect(Effect.runPromise(store.listForPullRequest("tenant-a", "pr-a", {}))).resolves.toMatchObject({ items: [{ id: created.id }], has_more: false });
    await expect(Effect.runPromise(store.listForPullRequest("tenant-b", "pr-a", {}))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("views checks and lists source-valid bounded annotations", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, gitRead });
    const created = await Effect.runPromise(store.create("tenant-a", actor, createExternal({ annotations: [annotation({ message: "first" }), annotation({ message: "second", level: "failure" })] })));

    const viewed = await Effect.runPromise(store.view("tenant-a", created.id));
    decodeSourceSchema(await readDomain(), "Check", viewed);
    expect(viewed).toMatchObject({ id: created.id, repository_id: "repo-a", annotations: [{ message: "first" }, { message: "second" }] });

    const firstPage = await Effect.runPromise(store.listAnnotations("tenant-a", created.id, { limit: 1 }));
    decodeSourceSchema(await readDomain(), "ExecutionCheckAnnotationPage", firstPage);
    expect(firstPage).toEqual({ items: [annotation({ message: "first" })], next_cursor: "1", has_more: true });
    await expect(Effect.runPromise(store.listAnnotations("tenant-b", created.id, {}))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects source-invalid annotation payloads before D1 writes", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, gitRead });
    const created = await Effect.runPromise(store.create("tenant-a", actor, createExternal()));
    const tooManyAnnotations = Array.from({ length: 51 }, (_, index) => annotation({ message: "annotation " + index }));

    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ annotations: tooManyAnnotations })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ annotations: [annotation({ message: "" })] })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.update("tenant-a", created.id, actor, 1, { annotations_append: tooManyAnnotations }))).rejects.toBeInstanceOf(DomainContractError);
  });

  it("updates with CAS producer authorization terminal guard and source-valid output", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, gitRead });
    const created = await Effect.runPromise(store.create("tenant-a", actor, createExternal()));

    const completed = await Effect.runPromise(store.update("tenant-a", created.id, actor, 1, { status: "completed", conclusion: "success", annotations_append: [{ path: "src/main.ts", start_line: 1, end_line: 1, start_column: null, end_column: null, level: "notice", message: "ok", title: null, raw_details: null }] }));
    expect(completed).toMatchObject({ version: 2, status: "completed", conclusion: "success", annotations: [{ message: "ok" }] });
    decodeSourceSchema(await readDomain(), "Check", completed);
    await expect(Effect.runPromise(store.update("tenant-a", created.id, actor, 1, { details_url: "https://checks.example/stale" }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.update("tenant-a", created.id, actor, 2, { conclusion: "failure" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const other = makeD1CheckStore(fixture(), { clock, gitRead });
    const owned = await Effect.runPromise(other.create("tenant-a", actor, createExternal()));
    await expect(Effect.runPromise(other.update("tenant-a", owned.id, { ...actor, id: "principal-b" }, 1, { details_url: "https://checks.example/other" }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects fabricated candidate-bound checks without a trusted candidate qualifier and writes nothing", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, gitRead });
    await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture()))).rejects.toBeInstanceOf(DomainContractError);
    await expect(countChecks(sql)).resolves.toBe(0);

    const calls: unknown[] = [];
    const withPort = makeD1CheckStore(sql, { clock, gitRead, candidateChecks: candidatePort(trustedCandidateProofFixture(), calls) });
    await expect(Effect.runPromise(withPort.create("tenant-a", actor, createCandidateFixture({ base_sha: null })))).rejects.toBeInstanceOf(DomainContractError);
    expect(calls).toHaveLength(0);
    await expect(countChecks(sql)).resolves.toBe(0);
  });

  it("accepts a fixture candidate-bound check only when the trusted proof independently matches the full tuple", async () => {
    const sql = fixture();
    const calls: unknown[] = [];
    const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture(), calls), gitRead: { resolveRef: () => Effect.die(new Error("candidate checks must not resolve through target git read")) } });

    await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture()))).resolves.toMatchObject({ candidate_bound: true, commit_sha: executionSha, head_sha: sourceHeadSha });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: "tenant-a", targetRepositoryId: "repo-a", producerId: "principal-a", context: "ci/build", commitSha: executionSha, headSha: sourceHeadSha, baseSha, executionSha, planDigest, policyDigest });
    await expect(countChecks(sql)).resolves.toBe(1);
  });

  it("rejects every trusted proof dimension mismatch before insert", async () => {
    const cases: readonly [string, Partial<CandidateProof>][] = [
      ["tenant", { tenantId: "tenant-b" }],
      ["target repository", { targetRepositoryId: "repo-other" }],
      ["source repository", { sourceRepositoryId: "" }],
      ["producer", { producerId: "principal-b" }],
      ["context", { context: "ci/test" }],
      ["candidate", { candidateSha: headSha }],
      ["head", { headSha }],
      ["base", { baseSha: staleHeadSha }],
      ["plan", { planDigest: "sha256:other-plan" }],
      ["policy", { policyDigest: "sha256:other-policy" }],
      ["eligibility", { eligibilityId: "" }],
      ["pr", { prId: "" }]
    ];

    for (const [label, proofOverride] of cases) {
      const sql = fixture();
      const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture(proofOverride)), gitRead });
      await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture())), label).rejects.toBeInstanceOf(DomainContractError);
      await expect(countChecks(sql), label).resolves.toBe(0);
    }
  });

  it("rejects malformed trusted proof records as domain errors before insert", async () => {
    const cases: readonly [string, unknown][] = [
      ["null proof", null],
      ["missing final fence", { ...trustedCandidateProofFixture(), writeFence: undefined }],
      ["blank final fence", { ...trustedCandidateProofFixture(), writeFence: { sql: "", bindings: [] } }],
      ["invalid final bindings", { ...trustedCandidateProofFixture(), writeFence: { sql: "1", bindings: [{}] } }],
      ["missing source repository", { ...trustedCandidateProofFixture(), sourceRepositoryId: undefined }],
      ["non-string eligibility", { ...trustedCandidateProofFixture(), eligibilityId: 42 }],
      ["non-string pull request", { ...trustedCandidateProofFixture(), prId: { id: "pr-a" } }],
      ["empty source repository", { ...trustedCandidateProofFixture(), sourceRepositoryId: "" }],
      ["empty eligibility", { ...trustedCandidateProofFixture(), eligibilityId: "" }],
      ["empty pull request", { ...trustedCandidateProofFixture(), prId: "" }]
    ];

    for (const [label, proof] of cases) {
      const sql = fixture();
      const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(proof as CandidateProof), gitRead });
      await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture())), label).rejects.toBeInstanceOf(DomainContractError);
      await expect(countChecks(sql), label).resolves.toBe(0);
    }
  });

  it("rejects every candidate request tuple mismatch against the trusted fixture proof before insert", async () => {
    const cases: readonly [string, Partial<CheckCreateInput>][] = [
      ["commit", { commit_sha: headSha, execution_sha: headSha }],
      ["head", { head_sha: headSha }],
      ["base", { base_sha: staleHeadSha }],
      ["execution", { commit_sha: headSha, execution_sha: executionSha }],
      ["plan", { plan_digest: "sha256:other-plan" }],
      ["policy", { policy_digest: "sha256:other-policy" }]
    ];

    for (const [label, inputOverride] of cases) {
      const sql = fixture();
      const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()), gitRead });
      await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture(inputOverride))), label).rejects.toBeInstanceOf(DomainContractError);
      await expect(countChecks(sql), label).resolves.toBe(0);
    }
  });

  it("binds candidate qualification to the producer and check context", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture()), gitRead });
    await expect(Effect.runPromise(store.create("tenant-a", { ...actor, id: "principal-b" }, createCandidateFixture()))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createCandidateFixture({ name: "ci/test" })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(countChecks(sql)).resolves.toBe(0);
  });

  it("keeps plain head checks on qualified target git-read even when a candidate qualifier exists", async () => {
    const sql = fixture();
    const calls: unknown[] = [];
    const store = makeD1CheckStore(sql, { clock, candidateChecks: candidatePort(trustedCandidateProofFixture(), calls) });
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal()))).rejects.toBeInstanceOf(DomainContractError);
    expect(calls).toHaveLength(0);
    await expect(countChecks(sql)).resolves.toBe(0);

    const qualified = makeD1CheckStore(sql, { clock, gitRead, candidateChecks: candidatePort(trustedCandidateProofFixture(), calls) });
    await expect(Effect.runPromise(qualified.create("tenant-a", actor, createExternal()))).resolves.toMatchObject({ candidate_bound: false, commit_sha: headSha });
    expect(calls).toHaveLength(0);
  });

  it("enforces terminal semantic rules", async () => {
    const sql = fixture();
    const store = makeD1CheckStore(sql, { clock, gitRead });
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ status: "completed", conclusion: null })))).rejects.toBeInstanceOf(DomainContractError);
  });
});

async function readDomain(): Promise<SourceDomainDocument> {
  return JSON.parse(readFileSync(new URL("../../../../docs/source/handoff/contracts/domain.schema.json", import.meta.url), "utf8")) as SourceDomainDocument;
}

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../docs/source/handoff/contracts/schema.sql", import.meta.url), "utf8"));
  seed(sql.db);
  return sql;
}

function seed(db: DatabaseSync) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "US", "{}");
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}");
  db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-a", 1, timestamp, timestamp, "human", "Principal A", 1, 1);
  db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-b", 1, timestamp, timestamp, "human", "Principal B", 1, 1);
  db.prepare("INSERT INTO organization_namespaces(tenant_id,id,version,created_at,updated_at,name,description) VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A");
  db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, "tenant-a", "repo-a", null);
  db.prepare("INSERT INTO issues(tenant_id,id,version,created_at,updated_at,repository_id,number,title,body,state,state_reason,author_id,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 1, timestamp, timestamp, "repo-a", 1, "PR", "", "open", "reopened", "principal-a", "pull_request");
  db.prepare("INSERT INTO pull_requests(tenant_id,id,version,created_at,updated_at,issue_id,repository_id,source_repository_id,source_ref,target_ref,head_sha,base_sha,draft,merge_sha,merged_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 1, timestamp, timestamp, "pr-a", "repo-a", "repo-a", "feature", "main", headSha, baseSha, 0, null, null, null);
}

async function seedCheck(db: DatabaseSync, input: { readonly id: string; readonly commitSha: string; readonly headSha: string; readonly providerRef: string }) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO checks(tenant_id,id,version,created_at,updated_at,repository_id,commit_sha,evidence_kind,candidate_bound,head_sha,base_sha,execution_sha,plan_digest,policy_digest,job_attempt_id,provider_evidence_ref,name,producer_id,status,conclusion,source_run_id,details_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)").run("tenant-a", input.id, 1, timestamp, timestamp, "repo-a", input.commitSha, "external", 0, input.headSha, null, null, null, null, null, input.providerRef, "ci/build", "principal-a", "completed", "success", JSON.stringify({ details_url: "https://checks.example/" + input.id, output: null, annotations: [] }));
}
