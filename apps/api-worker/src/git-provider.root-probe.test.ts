import { expect, test } from "vitest";
import { artifactsRepositoryIdentity } from "./git-provider.js";

test("distinct tenant and namespace tuples never share a provider repository", () => {
  const left = artifactsRepositoryIdentity({ tenantId: "tenant.a", namespaceId: "b", name: "repo" }, "gitfoundry-staging");
  const right = artifactsRepositoryIdentity({ tenantId: "tenant", namespaceId: "a.b", name: "repo" }, "gitfoundry-staging");
  expect(left).not.toEqual(right);
});
