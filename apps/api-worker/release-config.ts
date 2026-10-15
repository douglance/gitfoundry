export function deploymentStage(stage: string): "staging" | "production" {
  if (stage !== "staging" && stage !== "production") throw new Error("GitFoundry deployment stage must be staging or production");
  return stage;
}

export function trustedForgeKeys(value: string): string {
  const keys: unknown = JSON.parse(value);
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length === 0) throw new Error("GitFoundry publication requires trusted public keys");
  for (const [id, input] of Object.entries(keys)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid GitFoundry publication key");
    const key = input as Record<string, unknown>;
    if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || "d" in key) throw new Error("GitFoundry publication keys must be public Ed25519 JWKs");
  }
  return JSON.stringify(keys);
}
