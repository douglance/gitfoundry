import { TrustedGitHelperDO, UntrustedCiJobDO } from "./execution.js";

export class TrustedGitHelperPinnedDO extends TrustedGitHelperDO {}
export class UntrustedCiJobPinnedDO extends UntrustedCiJobDO {}

export { GitFoundryArtifactsEgress } from "../git-egress/index.js";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
