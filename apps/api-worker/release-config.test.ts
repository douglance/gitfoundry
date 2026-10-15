import { describe, expect, it } from "vitest";
import { deploymentStage, trustedForgeKeys } from "./release-config.js";

describe("release configuration", () => {
  it("permits only the two isolated release stages", () => {
    expect(deploymentStage("production")).toBe("production");
    expect(deploymentStage("staging")).toBe("staging");
    for (const stage of ["prod", "live_doug", "", "Production"]) expect(() => deploymentStage(stage)).toThrow("stage must be staging or production");
  });
  it("requires public publication keys and rejects private material", () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "a".repeat(43) };
    expect(JSON.parse(trustedForgeKeys(JSON.stringify({ owner: key })))).toEqual({ owner: key });
    for (const value of [{}, [], null, { owner: { ...key, d: "private" } }, { owner: { ...key, crv: "X25519" } }, { owner: { ...key, x: "short" } }]) {
      expect(() => trustedForgeKeys(JSON.stringify(value))).toThrow();
    }
  });
});
