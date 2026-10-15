import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";
import { deploymentStage, trustedForgeKeys } from "./release-config.js";

import { artifactsRepositoryIdentity } from "./src/git-provider.js";
import { providerContentQualificationRepositoryInput } from "./src/auth/provider-qualification.js";

import type { GitHubActionsBackendDO, TrustedGitHelperDO, UntrustedCiJobDO } from "./src/worker.js";
import { runProviderQualification, type ProviderQualificationProof, type ProviderQualificationRunnerInput } from "./qualify-provider.js";

const rootFile = (relative: string): string =>
  new URL(relative, import.meta.url).pathname;

export default Alchemy.Stack(
  "gitfoundry",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = deploymentStage(yield* Stage);
    const production = stage === "production";
    const gitNamespace = `gitfoundry-${stage}`;
    const ownerEmail = yield* Config.String("GFY_OWNER_EMAIL");
    const ownerSubject = yield* Config.String("GFY_OWNER_ACCESS_SUBJECT");
    if (ownerSubject.trim() !== ownerSubject || !ownerSubject || ownerSubject.length > 2048) throw new Error("GitFoundry owner subject must be an observed Access subject");
    const issuer = yield* Config.String("GFY_AUTH_ISSUER");
    const sourceRevision = yield* Config.String("GFY_SOURCE_REVISION");
    const publicationKeys = trustedForgeKeys(yield* Config.String("GFY_FORGE_TRUSTED_KEYS"));
    const reviewSigningKey = yield* Config.Redacted("GFY_FORGE_REVIEW_SIGNING_KEY");
    const reviewKeyId = yield* Config.String("GFY_FORGE_REVIEW_KEY_ID");
    const runnerRepositoryId = yield* Config.String("GFY_RUNNER_REPOSITORY_ID");
    if (!/^repo-[0-9a-f]{64}$/u.test(runnerRepositoryId)) throw new Error("GitFoundry runner repository must be an observed native repository id");
    const runnerPublicKey = yield* Config.String("GFY_RUNNER_PUBLIC_KEY");
    const runnerJwk = JSON.parse(runnerPublicKey) as Record<string, unknown>;
    if (runnerJwk.kty !== "OKP" || runnerJwk.crv !== "Ed25519" || typeof runnerJwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(runnerJwk.x) || "d" in runnerJwk) throw new Error("GitFoundry runner requires an Ed25519 public key without private material");
    const publicGitUrlBase = yield* Config.String("GFY_GIT_URL_BASE").pipe(Config.withDefault(production ? "https://gitfoundry.dev/git" : "https://staging.gitfoundry.dev/git"));
    const gitMaxRequestBytes = yield* Config.String("GFY_GIT_MAX_REQUEST_BYTES").pipe(Config.withDefault("8388608"));
    const gitMaxResponseBytes = yield* Config.String("GFY_GIT_MAX_RESPONSE_BYTES").pipe(Config.withDefault("1073741824"));
    const gitSessionTimeoutMs = yield* Config.String("GFY_GIT_SESSION_TIMEOUT_MS").pipe(Config.withDefault("55000"));
    for (const value of [gitMaxRequestBytes, gitMaxResponseBytes, gitSessionTimeoutMs]) {
      if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("GitFoundry Git transport limits must be positive safe integers");
    }
    if (Number(gitSessionTimeoutMs) > 55000) throw new Error("GitFoundry Git session deadline must not exceed its scoped read token lifetime");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(reviewKeyId)) throw new Error("GitFoundry review signing key id must be a safe key identifier");
    const publicGitUrl = new URL(publicGitUrlBase);
    if (publicGitUrl.protocol !== "https:" || publicGitUrl.username || publicGitUrl.password || publicGitUrl.search || publicGitUrl.hash) throw new Error("GitFoundry public Git URL must be HTTPS without credentials, query, or fragment");
    if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) throw new Error("GitFoundry source revision must be a full lowercase commit SHA");
    const db = yield* Cloudflare.D1.Database("Database", {
      migrations: rootFile("../../infra/migrations")
    });
    const artifacts = yield* Cloudflare.R2.Bucket("Artifacts");
    const git = yield* Cloudflare.Artifacts.Namespace("GitFoundryGit", {
      namespace: gitNamespace
    });
    const providerQualificationToken = yield* Cloudflare.Access.ServiceToken("ProviderQualificationFresh", {
      name: `gitfoundry-provider-qualification-${stage}`,
      duration: "720h"
    });
    const ownerRunnerToken = yield* Cloudflare.Access.ServiceToken("OwnerRunner", {
      name: `gitfoundry-owner-runner-${stage}`,
      duration: "720h"
    });
    const actionsPublicOrigin = yield* Config.String("GFY_ACTIONS_PUBLIC_ORIGIN").pipe(Config.withDefault(production ? "https://gitfoundry.dev" : "https://staging.gitfoundry.dev"));
    const actionsOrigin = new URL(actionsPublicOrigin);
    if (actionsOrigin.protocol !== "https:" || actionsOrigin.username || actionsOrigin.password || actionsOrigin.pathname !== "/" || actionsOrigin.search || actionsOrigin.hash) throw new Error("GitFoundry actions public origin must be an HTTPS origin without credentials, path, query, or fragment");
    const actionsStorageGeneration = yield* Config.String("GFY_ACTIONS_STORAGE_GENERATION");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(actionsStorageGeneration)) throw new Error("GitFoundry actions storage generation must be a safe durable generation id");
    const actionsOwnerTenantId = yield* Config.String("GFY_ACTIONS_OWNER_TENANT_ID").pipe(Config.withDefault("owner"));
    const actionsOwnerRepositoryId = yield* Config.String("GFY_ACTIONS_OWNER_REPOSITORY_ID");
    const actionsOwnerRepository = yield* Config.String("GFY_ACTIONS_OWNER_REPOSITORY").pipe(Config.withDefault("core/gitfoundry"));
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(actionsOwnerTenantId)) throw new Error("GitFoundry actions owner tenant id must be a safe id");
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(actionsOwnerRepositoryId)) throw new Error("GitFoundry actions owner repository id must be a safe id");
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(actionsOwnerRepository)) throw new Error("GitFoundry actions owner repository must be owner/repo");
    const actionsUpstreamRunnerToken = yield* Config.Redacted("GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN");
    const actionsInternalStorageSecret = yield* Config.Redacted("GFY_ACTIONS_INTERNAL_STORAGE_SECRET");
    const actionsRsaPrivateKey = yield* Config.Redacted("GFY_ACTIONS_RSA_PRIVATE_KEY");
    const actionsUpstreamJwtPublicKey = yield* Config.String("GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY");
    if (!actionsUpstreamJwtPublicKey.includes("PUBLIC KEY") && !/^\s*\{\s*\"kty\"\s*:\s*\"RSA\"/u.test(actionsUpstreamJwtPublicKey)) throw new Error("GitFoundry actions upstream JWT public key must be RSA PEM or JWK");
    const actionsSqlite = yield* Cloudflare.R2.Bucket("GitHubActionsSqlite");
    const emailCode = yield* Cloudflare.Access.IdentityProvider("EmailCode", { type: "onetimepin" });
    const access = yield* Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      sessionDuration: "1h",
      allowedIdps: [emailCode.identityProviderId],
      autoRedirectToIdentity: true,
      policies: [
        {
          name: `GitFoundry ${stage} owner`,
          decision: "allow",
          precedence: 1,
          include: [{ email: ownerEmail }]
        },
        {
          name: "GitFoundry provider qualification",
          decision: "non_identity",
          precedence: 2,
          sessionDuration: "720h",
          include: [{ serviceToken: { tokenId: providerQualificationToken.serviceTokenId } }]
        },
        {
          name: "GitFoundry owner runner",
          decision: "non_identity",
          precedence: 3,
          sessionDuration: "720h",
          include: [{ serviceToken: { tokenId: ownerRunnerToken.serviceTokenId } }]
        }
      ]
    });
    yield* Cloudflare.Access.Application("RunnerProtocolAccess", {
      type: "self_hosted",
      name: `GitFoundry ${stage} runner protocol`,
      destinations: [
        { type: "public", uri: `${actionsOrigin.host}/runner/*` },
        { type: "public", uri: `${actionsOrigin.host}/api/v3/actions/runner-registration` }
      ],
      policies: [
        {
          name: "GitFoundry runner protocol JWT boundary",
          decision: "bypass",
          precedence: 1,
          include: ["everyone"]
        }
      ]
    });

    class TrustedGitHelperContainer extends Cloudflare.Container<TrustedGitHelperDO>()("TrustedGitHelperDO", {
      context: rootFile("../../images"),
      dockerfile: rootFile("../../images/git-helper/Dockerfile"),
      publish: { repository: "gitfoundry-helper" },
      // Each repository gets its own helper, so a page that reads several repositories needs several.
      maxInstances: 5,
      schedulingPolicy: "default",
      className: "TrustedGitHelperDO"
    }) {}

    class UntrustedCiJobContainer extends Cloudflare.Container<UntrustedCiJobDO>()("UntrustedCiJobDO", {
      context: rootFile("../../images"),
      dockerfile: rootFile("../../images/ci-runner/Dockerfile"),
      publish: { repository: "gitfoundry-ci" },
      maxInstances: 1,
      schedulingPolicy: "default",
      className: "UntrustedCiJobDO"
    }) {}

    class GitHubActionsBackendContainer extends Cloudflare.Container<GitHubActionsBackendDO>()("GitHubActionsBackendDO", {
      context: rootFile("../../images"),
      dockerfile: rootFile("../../images/github-actions-server/Dockerfile"),
      publish: { repository: "gitfoundry-actions-server" },
      maxInstances: 1,
      schedulingPolicy: "default",
      className: "GitHubActionsBackendDO"
    }) {}

    const trustedGitHelperApplication = yield* TrustedGitHelperContainer.Application;
    const untrustedCiJobApplication = yield* UntrustedCiJobContainer.Application;
    const gitHubActionsBackendApplication = yield* GitHubActionsBackendContainer.Application;

    const api = yield* Cloudflare.Worker("Api", {
      main: rootFile("./src/worker.ts"),
      assets: {
        directory: rootFile("../web/dist"),
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/", "/index.html", "/api/*", "/git/*", "/runner/*", "/_*", "/health", "/internal*", "/identity*", "/invoke*", "/mcp*"]
      },
      compatibility: { date: "2026-10-07", flags: ["nodejs_compat"] },
      domain: production ? "gitfoundry.dev" : "staging.gitfoundry.dev",
      crons: ["*/5 * * * *"],
      workersDev: { enabled: true, previewsEnabled: false },
      access,
      env: {
        GFY_DB: db,
        GFY_ARTIFACTS: artifacts,
        GFY_GIT: git,
        GFY_GIT_NAMESPACE: gitNamespace,
        GFY_GIT_MAX_REQUEST_BYTES: gitMaxRequestBytes,
        GFY_GIT_MAX_RESPONSE_BYTES: gitMaxResponseBytes,
        GFY_GIT_SESSION_TIMEOUT_MS: gitSessionTimeoutMs,
        GFY_GIT_URL_BASE: publicGitUrlBase,
        GFY_SOURCE_REVISION: sourceRevision,
        GFY_FORGE_TRUSTED_KEYS: publicationKeys,
        GFY_FORGE_REVIEW_KEY_ID: reviewKeyId,
        GFY_FORGE_REVIEW_SIGNING_KEY: reviewSigningKey,
        GFY_RUNNER_ID: "owner-runner-production",
        GFY_RUNNER_TENANT_ID: "owner",
        GFY_RUNNER_REPOSITORY_ID: runnerRepositoryId,
        GFY_RUNNER_PUBLIC_KEY: runnerPublicKey,
        GFY_RUNNER_CLIENT_ID: ownerRunnerToken.clientId,
        GFY_RUNNER_CLIENT_SECRET: Output.map(ownerRunnerToken.clientSecret, (secret) => {
          if (secret === undefined) throw new Error("Managed runner secret unavailable; rotate through Alchemy");
          return secret;
        }),
        GFY_OWNER_ACCESS_SUBJECT: ownerSubject,
        GFY_OWNER_ACCESS_EMAIL: ownerEmail,
        GFY_OWNER_TENANT_ID: "owner",
        GFY_OWNER_NAMESPACE_ID: "core",
        GFY_AUTH_ISSUER: issuer,
        GFY_AUTH_AUDIENCE: access.aud,
        GFY_MCP_AUTH_AUDIENCE: access.aud,
        GFY_AUTH_JWKS_URL: `${issuer}/cdn-cgi/access/certs`,
        GFY_BODY_LIMIT_BYTES: "1048576",
        GFY_QUALIFIER_CLIENT_ID: providerQualificationToken.clientId,
        GFY_QUALIFIER_CLIENT_SECRET: Output.map(providerQualificationToken.clientSecret, (secret) => {
          if (secret === undefined) throw new Error("Managed provider qualification secret unavailable; rotate through Alchemy");
          return secret;
        }),
        GFY_TRUSTED_GIT_HELPER_IMAGE: trustedGitHelperApplication.configuration.image,
        GFY_UNTRUSTED_CI_IMAGE: untrustedCiJobApplication.configuration.image,
        GFY_ACTIONS_BACKEND_IMAGE: gitHubActionsBackendApplication.configuration.image,
        GFY_ACTIONS_SQLITE_BUCKET: actionsSqlite,
        GFY_ACTIONS_STORAGE_GENERATION: actionsStorageGeneration,
        GFY_ACTIONS_PUBLIC_ORIGIN: actionsOrigin.origin,
        GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN: actionsUpstreamRunnerToken,
        GFY_ACTIONS_INTERNAL_STORAGE_SECRET: actionsInternalStorageSecret,
        GFY_ACTIONS_RSA_PRIVATE_KEY: actionsRsaPrivateKey,
        GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID: ownerRunnerToken.clientId,
        GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET: Output.map(ownerRunnerToken.clientSecret, (secret) => {
          if (secret === undefined) throw new Error("Managed actions storage Access secret unavailable; rotate through Alchemy");
          return secret;
        }),
        GFY_ACTIONS_OWNER_TENANT_ID: actionsOwnerTenantId,
        GFY_ACTIONS_OWNER_REPOSITORY_ID: actionsOwnerRepositoryId,
        GFY_ACTIONS_OWNER_REPOSITORY: actionsOwnerRepository,
        GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY: actionsUpstreamJwtPublicKey,
        GFY_PR_ELIGIBILITY_DO: Cloudflare.DurableObject("PrEligibilityDO"),
        GITHUB_ACTIONS_BACKEND: GitHubActionsBackendContainer,
        TRUSTED_GIT_HELPER: TrustedGitHelperContainer,
        UNTRUSTED_CI_JOB: UntrustedCiJobContainer
      }
    });
    const mcp = yield* Cloudflare.Worker("Mcp", {
      main: rootFile("../../target/p0-remote-worker-build/index.js"),
      bundle: false,
      domain: production ? "mcp.gitfoundry.dev" : "mcp.staging.gitfoundry.dev",
      compatibility: { date: "2026-10-07", flags: [] },
      workersDev: { enabled: true, previewsEnabled: false },
      // MCP clients sign in with their GitFoundry session, not through Cloudflare Access.
      env: {
        GFY_SOURCE_REVISION: sourceRevision,
        API: Cloudflare.WorkerEntrypoint(api, "AgentApi"),
        CODEMODE: Cloudflare.DurableObject("GitFoundryCodeMode"),
        LOADER: Cloudflare.WorkerLoader("LOADER")
      }
    });

    const qualifyProvider = Alchemy.Action<"GitFoundry.ProviderQualification", ProviderQualificationRunnerInput, ProviderQualificationProof>(
      "GitFoundry.ProviderQualification",
      Effect.fn(function* (input) {
        return yield* Effect.tryPromise({
          try: () => runProviderQualification(input, { maxAttempts: 10, retryDelayMs: 3_000 }),
          catch: (error) => error
        });
      })
    );
    const providerQualification = yield* qualifyProvider({
      apiUrl: Output.map(api.url, (url) => {
        if (url === undefined) throw new Error("GitFoundry API URL is unavailable for provider qualification");
        return url;
      }),
      contentRepositoryName: artifactsRepositoryIdentity(providerContentQualificationRepositoryInput, gitNamespace).name,
      contentCommitSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      contentSha256: "03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340",
      contentByteLength: 13,
      sourceRevision,
      accessClientId: providerQualificationToken.clientId,
      accessClientSecret: providerQualificationToken.clientSecret,
      accessAudience: access.aud,
      providerQualificationServiceTokenId: providerQualificationToken.serviceTokenId,
      trustedGitHelperImage: trustedGitHelperApplication.configuration.image,
      untrustedCiImage: untrustedCiJobApplication.configuration.image
    });
    return {
      accountId: "88f9cbf5c4f4e217079bcbf0ca6cb181",
      sourceRevision,
      apiUrl: api.url,
      mcpUrl: mcp.url,
      databaseId: db.databaseId,
      accessAudience: access.aud,
      providerQualificationServiceTokenId: providerQualificationToken.serviceTokenId,
      providerQualificationServiceClientId: providerQualificationToken.clientId,
      providerQualification,
      trustedGitHelperImage: trustedGitHelperApplication.configuration.image,
      untrustedCiImage: untrustedCiJobApplication.configuration.image,
      stage,
      acceptance: "Provider qualification only; full product acceptance requires separate evidence"
    };
  })
);
