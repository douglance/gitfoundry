import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

import { decodeSourceSchema } from "@gitfoundry/contracts";
import { makeD1IdentityPort, type D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import type { QualifiedGitReadPort } from "../../../../packages/core/src/live/forge.js";
import { makeD1ArtifactsGitRead } from "../git-read.js";
import { sourceDomain } from "../source-catalog.generated.js";
import { makeArtifactsCandidateRuntime, type CandidatePreparationRuntimeEnv } from "./runtime.js";
import { makeD1PrEligibilityService, PrEligibilityError, type ForgePrEligibility, type PrEligibilityInput, type PrEligibilityService } from "./service.js";

export interface PrEligibilityCoordinatorEnv extends CandidatePreparationRuntimeEnv {
  readonly GFY_DB?: D1DatabaseLike;
  readonly DB?: D1DatabaseLike;
  readonly GFY_GIT_READ?: QualifiedGitReadPort;
}

export function makePrEligibilityCoordinator(service: PrEligibilityService) {
  const inFlight = new Map<string, Promise<ForgePrEligibility>>();
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/get") return failure(404);
      let input: PrEligibilityInput;
      try { input = parseInput(JSON.parse(await readRequest(request))); } catch { return failure(400); }
      const key = JSON.stringify([input.tenantId, input.pullRequestId, input.actorId, input.method ?? "merge", input.headSha ?? null, input.baseSha ?? null]);
      let pending = inFlight.get(key);
      if (!pending) {
        pending = Promise.resolve().then(() => service.get(input));
        inFlight.set(key, pending);
      }
      try {
        const snapshot = await pending;
        decodeSourceSchema(sourceDomain, "ForgePrEligibility", snapshot);
        if (snapshot.tenant_id !== input.tenantId || snapshot.pull_request_id !== input.pullRequestId || snapshot.method !== (input.method ?? "merge")) return failure(503);
        return Response.json(snapshot);
      } catch (error) {
        if (!(error instanceof PrEligibilityError)) return failure(503);
        const status = error.code === "not_found" ? 404 : error.code === "denied" ? 403 : error.code === "stale" ? 409 : 503;
        return failure(status, error.operationId);
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    }
  };
}

export class PrEligibilityDO extends DurableObject<PrEligibilityCoordinatorEnv> {
  private coordinator?: ReturnType<typeof makePrEligibilityCoordinator>;

  async fetch(request: Request): Promise<Response> {
    try {
      if (!this.coordinator) {
        const db = this.env.GFY_DB ?? this.env.DB;
        if (!db || !this.env.GFY_GIT_NAMESPACE || !this.env.TRUSTED_GIT_HELPER) return failure(503);
        const identity = makeD1IdentityPort(db, this.env.clock);
        const gitRead = this.env.GFY_GIT_READ ?? makeD1ArtifactsGitRead(db, this.env.GFY_GIT, { namespace: this.env.GFY_GIT_NAMESPACE });
        const runtime = makeArtifactsCandidateRuntime(db, { ...this.env, waitUntil: (promise) => this.ctx.waitUntil(promise) });
        const service = makeD1PrEligibilityService(db, {
          runtime, gitRead, ...(this.env.clock ? { clock: this.env.clock } : {}),
          authorize: async ({ tenantId, actorId, policyEpoch }) => {
            const authorization = await Effect.runPromiseExit(identity.verifyGrant({ tenantId, principalId: actorId, policyEpoch, capability: "pull_request.read" }));
            if (authorization._tag === "Failure") throw new PrEligibilityError("denied");
          }
        });
        this.coordinator = makePrEligibilityCoordinator(service);
      }
      return await this.coordinator.fetch(request);
    } catch {
      return failure(503);
    }
  }
}

function failure(status: number, operationId?: string): Response {
  const safeOperationId = typeof operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(operationId) ? operationId : undefined;
  return Response.json({ ok: false, error: "eligibility_unavailable", ...(safeOperationId ? { operation_id: safeOperationId } : {}) }, { status });
}

function parseInput(value: unknown): PrEligibilityInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid input");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["tenantId", "pullRequestId", "actorId", "method", "headSha", "baseSha"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("unknown input");
  const ids = ["tenantId", "pullRequestId", "actorId"] as const;
  for (const key of ids) if (typeof record[key] !== "string" || record[key].length < 1 || record[key].length > 128 || /[\u0000\r\n]/u.test(record[key])) throw new Error("invalid identity");
  const method = record.method === undefined ? "merge" : record.method;
  if (typeof method !== "string" || !["merge", "squash", "rebase", "fast-forward"].includes(method)) throw new Error("invalid method");
  for (const key of ["headSha", "baseSha"] as const) if (record[key] !== undefined && (typeof record[key] !== "string" || !/^[0-9a-f]{40}$/u.test(record[key]))) throw new Error("invalid revision");
  return { tenantId: record.tenantId as string, pullRequestId: record.pullRequestId as string, actorId: record.actorId as string, method: method as ForgePrEligibility["method"], ...(record.headSha === undefined ? {} : { headSha: record.headSha as string }), ...(record.baseSha === undefined ? {} : { baseSha: record.baseSha as string }) };
}

async function readRequest(request: Request): Promise<string> {
  if (!request.body) throw new Error("missing body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > 8192) { await reader.cancel().catch(() => undefined); throw new Error("body too large"); }
      text += decoder.decode(read.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
