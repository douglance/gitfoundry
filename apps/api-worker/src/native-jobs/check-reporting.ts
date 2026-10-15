import { Effect } from "effect";

import type { CheckStore } from "../../../../packages/core/src/checks/index.js";
import { makeD1CheckStore, type CandidateCheckQualificationPort } from "../../../../packages/core/src/live/checks.js";
import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import { makeNativeJobCandidateCheckQualifier, type NativeCandidateCheckQualificationToken, type NativeJobConclusion, type NativeJobStatus } from "./store.js";

export interface NativeCandidateCheckReportingOptions {
  readonly clock?: { readonly now: () => Date };
  readonly candidateChecks?: CandidateCheckQualificationPort;
}

export function makeNativeCandidateCheckStore(db: D1DatabaseLike, options: NativeCandidateCheckReportingOptions = {}): CheckStore {
  const candidateChecks = options.candidateChecks ?? makeTrustedNativeJobCandidateCheckQualifier(db, options.clock ? { clock: options.clock } : {});
  return makeD1CheckStore(db, { clock: options.clock, candidateChecks });
}

export function makeTrustedNativeJobCandidateCheckQualifier(db: D1DatabaseLike, options: { readonly clock?: { readonly now: () => Date } } = {}): CandidateCheckQualificationPort {
  const native = makeNativeJobCandidateCheckQualifier(db, options);
  return {
    qualifyCandidateCheck: (request) => {
      const planDigest = rawNativeDigestFromPublicDigest(request.planDigest);
      const policyDigest = rawNativeDigestFromPublicDigest(request.policyDigest);
      const nativeRequest = { ...request, planDigest, policyDigest, input: { ...request.input, plan_digest: planDigest, policy_digest: policyDigest } };
      return Effect.map(native.qualifyCandidateCheck(nativeRequest), (proof) => ({ ...proof, planDigest: request.planDigest, policyDigest: request.policyDigest }));
    }
  };
}

export async function readNativeJobCheckToken(db: D1DatabaseLike, input: { readonly tenantId: string; readonly jobAttemptId: string; readonly status: NativeJobStatus; readonly conclusion: NativeJobConclusion | null }): Promise<NativeCandidateCheckQualificationToken | null> {
  const row = await db.prepare("SELECT token_json FROM native_candidate_check_qualification_tokens WHERE tenant_id = ? AND job_attempt_id = ? AND status = ? AND conclusion IS ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(input.tenantId, input.jobAttemptId, input.status, input.conclusion).first<{ token_json: string }>();
  return row ? JSON.parse(row.token_json) as NativeCandidateCheckQualificationToken : null;
}

export function rawNativeDigestFromPublicDigest(value: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  return match ? match[1]! : value;
}
