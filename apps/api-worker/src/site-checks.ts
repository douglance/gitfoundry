import { authenticateSession, type EmailSignInEnv } from "./email-sign-in/index.js";
import { loadRepository, type RepositoryLoadPorts } from "./repository-load-check.js";

// Production checks itself on a schedule: the repository load check runs against the canonical
// repository, each result is recorded, and the owner workspace reads the recent results.
export interface SiteChecksEnv extends EmailSignInEnv {
  readonly GFY_RUNNER_TENANT_ID?: string;
  readonly GFY_RUNNER_REPOSITORY_ID?: string;
}

export const siteChecksPath = "/api/v1/site-checks";
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const listLimit = 50;

export async function recordSiteCheck(env: SiteChecksEnv, ports: RepositoryLoadPorts, now: Date): Promise<void> {
  const db = env.GFY_DB ?? env.DB;
  const tenantId = env.GFY_RUNNER_TENANT_ID;
  const repositoryId = env.GFY_RUNNER_REPOSITORY_ID;
  if (!db || !tenantId || !repositoryId) {
    console.error("gitfoundry.site_check.unconfigured");
    return;
  }
  const started = Date.now();
  const result = await loadRepository(ports, tenantId, repositoryId);
  const duration = Math.max(0, Date.now() - started);
  if (!result.ok) console.error("gitfoundry.site_check.failed", { stage: result.stage, cause: result.cause });
  const statements = [
    db.prepare("INSERT INTO site_checks(checked_at, ok, stage, code, duration_ms) VALUES(?,?,?,?,?)").bind(now.toISOString(), result.ok ? 1 : 0, result.ok ? null : result.stage, result.ok ? null : result.cause.code, duration),
    db.prepare("DELETE FROM site_checks WHERE checked_at < ?").bind(new Date(now.getTime() - retentionMs).toISOString())
  ];
  if (!db.batch) throw new Error("Recording a site check requires D1 batch");
  await db.batch(statements);
}

export async function handleSiteChecks(request: Request, env: SiteChecksEnv): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== siteChecksPath) return undefined;
  if (request.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  const db = env.GFY_DB ?? env.DB;
  const ownerTenantId = env.GFY_RUNNER_TENANT_ID;
  if (!db || !ownerTenantId) return Response.json({ error: "site checks unconfigured" }, { status: 503 });
  const session = await authenticateSession(request.headers, env, ownerTenantId, "repository.read");
  if (!session) return Response.json({ error: "gfy_auth_required" }, { status: 401 });
  if (!session.ok) return Response.json({ error: session.error }, { status: session.status });
  const rows = await db.prepare("SELECT checked_at, ok, stage, code, duration_ms FROM site_checks ORDER BY checked_at DESC LIMIT ?").bind(listLimit).all<{ checked_at: string; ok: number; stage: string | null; code: string | null; duration_ms: number }>();
  return Response.json({ checks: (rows.results ?? []).map(row => ({ checked_at: row.checked_at, ok: row.ok === 1, stage: row.stage, code: row.code, duration_ms: row.duration_ms })) }, { headers: { "Cache-Control": "no-store" } });
}
