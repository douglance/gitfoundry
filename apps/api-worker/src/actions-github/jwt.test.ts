import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { mintRegistrationJwt, verifyRegistrationJwt, type RegistrationJwtEnv } from "./jwt.js";

const scope = { tenantId: "tenant-a", repositoryId: "repo-a", repository: "core/gitfoundry" };
const now = new Date("2026-10-09T18:00:00.000Z");

function rsaEnv(): RegistrationJwtEnv {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    GFY_ACTIONS_REGISTRATION_JWT_PRIVATE_KEY: JSON.stringify(pair.privateKey.export({ format: "jwk" })),
    GFY_ACTIONS_REGISTRATION_JWT_PUBLIC_KEY: JSON.stringify(pair.publicKey.export({ format: "jwk" }))
  };
}

describe("registration JWT verification", () => {
  it("rejects a token whose RSA signature is checked with an independent public key", async () => {
    const signedWith = rsaEnv();
    const verifiedWith = rsaEnv();
    const token = (await mintRegistrationJwt(signedWith, scope, now)).token;

    await expect(verifyRegistrationJwt(verifiedWith, token, scope, now)).resolves.toBeNull();
  });
});
