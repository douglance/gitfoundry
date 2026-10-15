import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSourcePackRequest, parseSourcePackResult, validateSourcePackManifest } from "./source-packs.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const input = {
  tenantId:"tenant-a",repositoryId:"repo-a",operationId:"op-a",fenceToken:"fence-a",
  providerRepositoryId:"namespace-a/repo-a",ref:"refs/heads/main",expectedOid:"1".repeat(40),
  role:"source_target_pack" as const,remoteUrl:"https://gitfoundry-artifacts.internal/git/namespace-a/repo-a.git",
  username:"private-user",password:"private-password",opaqueProof:"private-egress-proof-123456",allowWrite:false
};
function success(frame: ReturnType<typeof buildSourcePackRequest>) {
 return {frame:"gitfoundry.source-pack.result.v1",ok:true,status:"packed",tenant_id:"tenant-a",repository_id:"repo-a",operation_id:"op-a",fence_token:"fence-a",provider_repository:"namespace-a/repo-a",ref:"refs/heads/main",expected_oid:"1".repeat(40),tip:"1".repeat(40),role:"source_target_pack",request_sha256:frame.requestSha256,pack_sha256:"2".repeat(64),pack_size_bytes:64,pack_filename:"source.pack",manifest_sha256:"3".repeat(64),git_version:"2.39.5",state_ref:"source-pack/manifest.json"};
}
describe("Worker source-pack protocol",()=>{
 it("keeps credentials and proof outside the public source identity",()=>{
  const first=buildSourcePackRequest(input);
  const rotated=buildSourcePackRequest({...input,password:"rotated-password",opaqueProof:"rotated-proof-123456789"});
  expect(first.requestSha256).toBe(rotated.requestSha256);
  expect(first.argv.join(" ")).not.toContain(input.password);
  expect(JSON.stringify(first.public)).not.toContain(input.opaqueProof);
  expect(JSON.parse(first.stdin).private).toMatchObject({artifacts_egress_proof:input.opaqueProof,credential:{password:input.password}});
 });
 it("binds public source identity to the ref, tip, provider, scope and fence",()=>{
  const first=buildSourcePackRequest(input);
  for(const changed of [{ref:"refs/heads/other"},{expectedOid:"4".repeat(40)},{providerRepositoryId:"namespace-a/other"},{repositoryId:"repo-b"},{operationId:"op-b"},{fenceToken:"fence-b"},{role:"source_head_pack" as const}]) {
   expect(buildSourcePackRequest({...input,...changed}).requestSha256).not.toBe(first.requestSha256);
  }
 });
 it("denies write capability, invalid references and oversized private input",()=>{
  expect(()=>buildSourcePackRequest({...input,allowWrite:true})).toThrow(/read.only/);
  expect(()=>buildSourcePackRequest({...input,ref:"refs/heads/../other"})).toThrow(/ref/);
  expect(()=>buildSourcePackRequest({...input,password:"x".repeat(9000)})).toThrow(/credential|bound/);
  expect(()=>buildSourcePackRequest({...input,opaqueProof:"bad\nproof"})).toThrow(/proof/);
 });
 it("accepts a pinned helper result and rejects substituted tips, scopes, lengths and fields",()=>{
  const frame=buildSourcePackRequest(input), result=success(frame);
  expect(parseSourcePackResult(JSON.stringify(result)+"\n",frame)).toMatchObject({packSha256:"2".repeat(64),packSizeBytes:64});
  for(const changed of [{tip:"4".repeat(40)},{repository_id:"repo-b"},{request_sha256:"4".repeat(64)},{pack_size_bytes:129*1024*1024},{git_version:"2.53.0"},{unknown:"value"},{pack_filename:"../other"}]) {
   expect(()=>parseSourcePackResult(JSON.stringify({...result,...changed}),frame)).toThrow();
  }
 });
 it("binds manifest bytes to the actual result and public request",()=>{
  const frame=buildSourcePackRequest(input);
  const manifest={frame:"gitfoundry.source-pack.manifest.v1",public:frame.public,request_sha256:frame.requestSha256,pack:{filename:"source.pack",sha256:"2".repeat(64),size_bytes:64},git_version:"2.39.5"};
  const text=JSON.stringify(manifest)+"\n";
  const parsed=parseSourcePackResult(JSON.stringify({...success(frame),manifest_sha256:sha(text)}),frame);
  expect(()=>validateSourcePackManifest(text,frame,parsed)).not.toThrow();
  expect(()=>validateSourcePackManifest(JSON.stringify({...manifest,public:{...frame.public,ref:"refs/heads/other"}}),frame,parsed)).toThrow(/digest/);
  const wrong=JSON.stringify({...manifest,pack:{...manifest.pack,size_bytes:65}})+"\n";
  const forged=parseSourcePackResult(JSON.stringify({...success(frame),manifest_sha256:sha(wrong)}),frame);
  expect(()=>validateSourcePackManifest(wrong,frame,forged)).toThrow(/pack/);
 });
});
