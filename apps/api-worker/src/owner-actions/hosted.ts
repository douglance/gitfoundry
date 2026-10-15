import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson, decodeBase64Utf8, encodeBase64Utf8, makeForgeService, type ForgeActor, type ForgeGitPort, type ForgeVersion, type ForkForgeChange } from "@gitfoundry/core";
import { authenticateHostedActionOwner, type Env } from "../index.js";
import { canonicalPublicationEvidencePayload, verifyPublicationEvidence, type PublicationCheckEvidenceRecord } from "../fork-forge/evidence.js";
import { describeForgeFailure, type ForgeFailureDescription } from "../fork-forge/http.js";
import { authenticateRunner, handleOwnerActions, readJson, type OwnerActionsEnv, type OwnerActionsPorts, type OwnerActionRun, type OwnerRunReceipt } from "./index.js";

export type HostedActionsEnv = Env & OwnerActionsEnv & {
  readonly GFY_RUNNER_PUBLIC_KEY?: string;
  readonly GFY_FORGE_TRUSTED_KEYS?: string;
  readonly GFY_FORGE_REVIEW_KEY_ID?: string;
};

const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const runnerKeyId = "owner-runner-production";
const testCommand = ["node", "scripts/test-all.mjs"];

export async function handleHostedActions(request: Request, env: HostedActionsEnv): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/_runner/") && !/^\/api\/v2\/tenants\/[^/]+\/repositories\/[^/]+\/actions\/runs(?:\/[^/]+)?$/.test(path)) return undefined;
  try {
    const ports = makeHostedActionsPorts(env);
    if (["/_runner/source/grant", "/_runner/source/adopt", "/_runner/runs"].includes(path)) {
      const auth = await authenticateRunner(request, env);
      if (!auth.ok) return auth.response;
      if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
      const scope = runnerScope(env);
      const body = await readJson(request);
      const operationId = safeId(body.operation_id, "operation_id");
      if (path === "/_runner/source/grant") {
        const grant = await repositoryGrant(env, scope, "write");
        return Response.json({ ...grant, ref: "refs/heads/source-imports/" + operationId });
      }
      if (path === "/_runner/source/adopt") {
        const codeCommit = sha(body.code_commit);
        const git = await gitFor(env, scope);
        if (await git.readRef("refs/heads/source-imports/" + operationId) !== codeCommit) return Response.json({ error: "source_import_ref_mismatch" }, { status: 409 });
        const service = forgeFor(env, scope, git);
        const actor = runnerActor(env);
        const head = await service.head(actor);
        let version: ForgeVersion;
        if (!head) {
          version = await service.initialize({ operation_id: operationId, code_commit: codeCommit, initial_state: await initialState(env, git, codeCommit), actor });
        } else {
          const expectedHead = typeof body.expected_head === "string" ? sha(body.expected_head) : null;
          const replayingCompletedOperation = expectedHead !== null && expectedHead !== head.version_commit && await git.readRef("refs/heads/operations/" + operationId + "/result");
          if (expectedHead !== head.version_commit && !replayingCompletedOperation) return Response.json({ error: "head_changed", actual_head: head.version_commit }, { status: 409 });
          const parent = replayingCompletedOperation ? await service.read(expectedHead!, actor) : head;
          const deletes: ForkForgeChange[] = (await git.listTree(parent.descriptor.state_commit, "")).filter(entry => entry.path.startsWith("checks/") || entry.path.startsWith("reviews/")).map(entry => ({ tree: "state", path: entry.path, content_base64: null }));
          version = await service.adoptCodeCommit({ operation_id: operationId, parent_version: parent.version_commit, expected_parent_code_commit: parent.descriptor.code_commit, code_commit: codeCommit, changes: deletes, actor });
        }
        return Response.json({ version_commit: version.version_commit, code_commit: version.descriptor.code_commit, head_version_commit: (await service.head(actor))?.version_commit });
      }
      const delegated = new Request(new URL("/api/v2/tenants/" + scope.tenantId + "/repositories/" + scope.repositoryId + "/actions/runs", request.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return await handleOwnerActions(delegated, env, { ...ports, authenticateOwner: async () => ({ ok: true, actor_id: auth.runner_id }) });
    }
    return await handleOwnerActions(request, env, ports);
  } catch (error) {
    const cause = hostedFailureCause(error);
    console.error("gitfoundry.hosted_actions.unavailable", cause);
    return Response.json({ error: "hosted_actions_unavailable", cause }, { status: 503 });
  }
}

// GitFoundry's own failures carry fixed lowercase messages; provider messages can carry credentials.
function hostedFailureCause(error: unknown): ForgeFailureDescription & { readonly message?: string } {
  const message = error instanceof Error && /^[a-z][a-z ]{0,79}$/u.test(error.message) ? { message: error.message } : {};
  return { ...describeForgeFailure(error), ...message };
}

export function makeHostedActionsPorts(env: HostedActionsEnv): OwnerActionsPorts {
  return {
    authenticateOwner: ({ request, tenant_id, capability }) => authenticateHostedActionOwner(request, env, tenant_id, capability),
    getForgeHead: async ({ tenant_id, repository_id }) => {
      const scope = { tenantId: tenant_id, repositoryId: repository_id };
      const service = forgeFor(env, scope, await gitFor(env, scope));
      const head = await service.head(runnerActor(env));
      if (!head) throw new Error("forge head missing");
      return { version_commit: head.version_commit, code_commit: head.descriptor.code_commit };
    },
    readVersion: async ({ tenant_id, repository_id, version_commit }) => {
      const scope = { tenantId: tenant_id, repositoryId: repository_id };
      const version = await forgeFor(env, scope, await gitFor(env, scope)).read(version_commit, runnerActor(env));
      return { version_commit: version.version_commit, code_commit: version.descriptor.code_commit };
    },
    checkoutGrant: async ({ run }) => ({ ...await repositoryGrant(env, runScope(run), "read"), commit: run.code_commit }),
    checkEvidenceTemplate: async ({ run }) => {
      if (run.kind !== "all-tests") return {};
      const git = await gitFor(env, runScope(run));
      const version = await forgeFor(env, runScope(run), git).read(run.version_commit, runnerActor(env));
      const policy = await readJsonFile(git, version.descriptor.state_commit, "config/publication.json");
      const evaluator = await readJsonFile(git, version.descriptor.state_commit, "config/evaluator.json");
      const digest = await evaluatorDigest(git, run.code_commit, evaluator);
      if (digest !== policy.evaluator_digest) throw new Error("evaluator configuration requires owner approval");
      return { schema_version: 1, kind: "check", id: "all-tests", candidate_code_commit: run.code_commit, evaluator_digest: digest, actor_id: runnerActor(env).id, actor_kind: "service", key_id: runnerKeyId };
    },
    verifyReceipt: async ({ receipt, signature }) => verifyRunnerSignature(env, canonicalJson(receipt), signature, "base64url"),
    recordEvidence: async ({ run, receipt, signature }) => {
      const git = await gitFor(env, runScope(run));
      const service = forgeFor(env, runScope(run), git);
      const parent = await service.read(run.version_commit, runnerActor(env));
      const changes: ForkForgeChange[] = [{ tree: "state", path: "actions/runs/" + run.id + ".json", content_base64: encodeBase64Utf8(JSON.stringify({ run, receipt, signature })) }];
      if (run.kind === "all-tests") {
        const check = receipt.publication_check as unknown as PublicationCheckEvidenceRecord | undefined;
        const template = await makeHostedActionsPorts(env).checkEvidenceTemplate!({ run });
        if (!check || canonicalJson({ ...check, outcome: undefined, signature: undefined }) !== canonicalJson({ ...template, outcome: undefined, signature: undefined }) || check.outcome !== (receipt.exit_code === 0 ? "passed" : "failed")) throw new Error("publication check binding mismatch");
        if (!verifyRunnerSignature(env, canonicalPublicationEvidencePayload(check), check.signature, "base64")) throw new Error("publication check signature invalid");
        changes.push({ tree: "state", path: "checks/all-tests.json", content_base64: encodeBase64Utf8(JSON.stringify(check)) });
      }
      const result = await service.commit({ operation_id: derivedOperationId("receipt", run.id), parent_version: parent.version_commit, changes, actor: runnerActor(env) });
      return { evidence_ref: result.version_commit };
    },
    verifyDeploymentAdmission: async ({ run }) => {
      const git = await gitFor(env, runScope(run));
      const service = forgeFor(env, runScope(run), git);
      const candidate = await service.read(run.version_commit, runnerActor(env));
      const head = await service.head(runnerActor(env));
      if (!head || head.version_commit !== run.head_version_commit || head.version_commit !== candidate.version_commit || candidate.descriptor.code_commit !== run.code_commit) throw new Error("deployment source is stale");
      const trustedKeys = JSON.parse(env.GFY_FORGE_TRUSTED_KEYS ?? "{}") as Record<string, JsonWebKey>;
      await verifyPublicationEvidence({ git, trustedKeys, context: { actor: runnerActor(env), expected: head, candidate } });
    },
    ...(env.clock ? { clock: env.clock } : {})
  };
}

type Scope = { readonly tenantId: string; readonly repositoryId: string };
function runnerScope(env: HostedActionsEnv): Scope { return { tenantId: safeId(env.GFY_RUNNER_TENANT_ID, "runner tenant"), repositoryId: safeId(env.GFY_RUNNER_REPOSITORY_ID, "runner repository") }; }
function runScope(run: OwnerActionRun): Scope { return { tenantId: run.tenant_id, repositoryId: run.repository_id }; }
function runnerActor(env: HostedActionsEnv): ForgeActor { return { id: safeId(env.GFY_RUNNER_ID, "runner id"), kind: "service" }; }
function assertScope(env: HostedActionsEnv, scope: Scope): void { const fixed = runnerScope(env); if (scope.tenantId !== fixed.tenantId || scope.repositoryId !== fixed.repositoryId) throw new Error("runner scope mismatch"); }
async function gitFor(env: HostedActionsEnv, scope: Scope): Promise<ForgeGitPort> {
  assertScope(env, scope);
  const configured = env.GFY_FORGE_GIT;
  const git = typeof configured === "function" ? await configured(scope) : configured;
  if (!git) throw new Error("forge backend missing");
  return git;
}
function forgeFor(env: HostedActionsEnv, scope: Scope, git: ForgeGitPort) {
  assertScope(env, scope);
  return makeForgeService({ git, tenant_id: scope.tenantId, repository_id: scope.repositoryId, clock: () => (env.clock?.now() ?? new Date()).toISOString(), authorize: async ({ actor }) => { if (actor.id !== runnerActor(env).id || actor.kind !== "service") throw new Error("runner actor mismatch"); }, verifyEvidence: async context => { if (!env.GFY_FORGE_VERIFY_EVIDENCE) throw new Error("evidence verifier missing"); await env.GFY_FORGE_VERIFY_EVIDENCE({ ...context, tenant_id: scope.tenantId, repository_id: scope.repositoryId }); } });
}
async function repositoryGrant(env: HostedActionsEnv, scope: Scope, access: "read" | "write") {
  assertScope(env, scope);
  const db = env.GFY_DB ?? env.DB;
  const row = await db?.prepare("SELECT artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(scope.tenantId, scope.repositoryId).first<{ artifacts_namespace: string; artifacts_name: string }>();
  if (!row || row.artifacts_namespace !== env.GFY_GIT_NAMESPACE || !env.GFY_GIT) throw new Error("runner repository missing");
  const repo = await env.GFY_GIT.get(row.artifacts_name);
  try {
    const info = await repo.info();
    if (info.name !== row.artifacts_name || !info.remote) throw new Error("provider identity mismatch");
    const remote = new URL(info.remote);
    if (remote.protocol !== "https:" || remote.username || remote.password) throw new Error("provider remote invalid");
    const token = await repo.createToken(access, 900);
    if (!token.plaintext || !token.expiresAt) throw new Error("provider grant missing");
    return { remote: remote.toString(), username: "x-access-token", password: token.plaintext, expires_at: token.expiresAt };
  } finally { repo[Symbol.dispose]?.(); }
}
async function initialState(env: HostedActionsEnv, git: ForgeGitPort, code: string) {
  const evaluator = await readJsonFile(git, code, ".forge/evaluator.json");
  const digest = await evaluatorDigest(git, code, evaluator);
  const policy = { schema_version: 1, evaluator_digest: digest, checks: [{ id: "all-tests", actor_ids: [runnerActor(env).id], actor_kinds: ["service"], key_ids: [runnerKeyId] }], reviews: { required_approvals: 1, trusted_reviewer_ids: ["owner"], actor_kinds: ["human"], key_ids: [env.GFY_FORGE_REVIEW_KEY_ID] } };
  const keys = JSON.parse(env.GFY_FORGE_TRUSTED_KEYS ?? "{}") as Record<string, JsonWebKey>;
  if (!keys[runnerKeyId] || !env.GFY_FORGE_REVIEW_KEY_ID || !keys[env.GFY_FORGE_REVIEW_KEY_ID]) throw new Error("publication keys missing");
  return Object.entries({ "config/evaluator.json": evaluator, "config/publication.json": policy, "config/trusted-keys.json": keys }).map(([path, value]) => ({ path, content_base64: encodeBase64Utf8(JSON.stringify(value)) }));
}
async function evaluatorDigest(git: ForgeGitPort, code: string, evaluator: Record<string, unknown>) {
  if (evaluator.schema_version !== 1 || canonicalJson(evaluator.command) !== canonicalJson(testCommand) || !Array.isArray(evaluator.files) || !evaluator.files.length || evaluator.runtime !== "local-native-owner") throw new Error("evaluator invalid");
  const files: Record<string, string> = {};
  for (const path of evaluator.files) {
    if (typeof path !== "string") throw new Error("evaluator path invalid");
    const content = await git.readFile(code, path);
    if (content === null) throw new Error("evaluator file missing");
    files[path] = content;
  }
  return "sha256:" + createHash("sha256").update(canonicalJson({ command: evaluator.command, runtime: evaluator.runtime, files })).digest("hex");
}
async function readJsonFile(git: ForgeGitPort, commit: string, path: string): Promise<Record<string, unknown>> {
  const content = await git.readFile(commit, path);
  if (!content) throw new Error("forge configuration missing");
  const record: unknown = JSON.parse(decodeBase64Utf8(content));
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("forge configuration invalid");
  return record as Record<string, unknown>;
}
function verifyRunnerSignature(env: HostedActionsEnv, payload: string, signature: string, encoding: "base64" | "base64url"): boolean {
  try { const jwk = JSON.parse(env.GFY_RUNNER_PUBLIC_KEY ?? "{}"); if (jwk.d || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return false; return verify(null, Buffer.from(payload), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, encoding)); } catch { return false; }
}
function safeId(value: unknown, label: string): string { if (typeof value !== "string" || !idPattern.test(value)) throw new Error(label + " invalid"); return value; }
function sha(value: unknown): string { if (typeof value !== "string" || !shaPattern.test(value)) throw new Error("commit invalid"); return value; }
function derivedOperationId(prefix: string, value: string): string { return prefix + "-" + createHash("sha256").update(value).digest("hex"); }
