import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers",()=>({DurableObject:class {}}));
import { prepareStoredMergeCandidate } from "./pipeline.js";
import { buildMergeCandidateAdmission, parseMergeCandidateResult, type MergeCandidatePrepareInput } from "./index.js";
import { byteStream, canonicalJson, type StoredSourcePack } from "./source-packs.js";
import type { ImmutableBlobLocator, CandidateArtifactInput } from "./artifact-store.js";
const hash=(s:string|Uint8Array)=>createHash("sha256").update(s).digest("hex");
const image="registry.example/helper@sha256:"+"a".repeat(64);
const env={GFY_TRUSTED_GIT_HELPER_IMAGE:image};
function fixture(method:MergeCandidatePrepareInput["method"]="merge",sourceRepositoryId="repo-a") {
 const tree="3".repeat(40),base="1".repeat(40);
 const raw=new TextEncoder().encode("tree "+tree+"\nparent "+base+"\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nCandidate\n");
 const candidateOid=createHash("sha1").update("commit "+raw.length+"\0").update(raw).digest("hex");
 const input:MergeCandidatePrepareInput={commandId:"candidate-a",tenantId:"tenant-a",repositoryId:"repo-a",operationId:"candidate-op",fenceToken:"fence-a",pullRequestId:"pr-a",pullRequestVersion:4,headSha:method==="fast_forward"?candidateOid:"2".repeat(40),baseSha:base,method,committerName:"A",committerEmail:"a@example.invalid",committedAt:"2026-10-09T00:00:00.000Z",message:"Candidate"};
 const result={frame:"gitfoundry.merge-candidate.result.v1",ok:true,status:"prepared",tenant_id:input.tenantId,repository_id:input.repositoryId,operation_id:input.operationId,pull_request_id:input.pullRequestId,pull_request_version:input.pullRequestVersion,method,head_sha:input.headSha,base_sha:base,candidate_oid:candidateOid,candidate_tree:tree,candidate_bytes_sha256:hash(raw),git_version:"2.39.5",state_ref:"merge-candidates/requests/"+buildMergeCandidateAdmission(input,env).requestSha256+"/manifest.json",original_to_rebased:method==="rebase"?[{original:input.headSha,rebased:candidateOid}]:[]};
 const requestSha=buildMergeCandidateAdmission(input,env).requestSha256,pack=new TextEncoder().encode("PACK candidate fixture stream bytes");
 const reviewedDiff={algorithm_version:"git-cli-unified-v1",comparison:"three_dot",context_lines:3,head_sha:input.headSha,base_sha:base,merge_base_shas:[base],patch_sha256:hash(""),patch_size_bytes:0,changed_paths_sha256:hash("")};
 const manifest={request_sha256:requestSha,method,head_sha:input.headSha,base_sha:base,candidate_oid:candidateOid,candidate_tree:tree,candidate_bytes_sha256:hash(raw),candidate_size_bytes:raw.length,pack_size_bytes:pack.length,candidate_parents:[base],bundle_sha256:hash(pack),pack_file:"/work/tenant-a/repo-a/candidate-op/merge-candidates/requests/"+requestSha+"/candidate-pack-"+"4".repeat(40)+".pack",git_version:"2.39.5",observed_git_version:"git version 2.39.5",original_to_rebased:result.original_to_rebased,result,reviewed_diff:{...reviewedDiff}};
 const bodies=new Map<string,Uint8Array>(),calls:string[][]=[],stored:CandidateArtifactInput[]=[];
 function locator(op:string,request:string,kind:ImmutableBlobLocator["kind"],bytes:Uint8Array,repositoryId="repo-a"):ImmutableBlobLocator {
  const key="v1/tenants/tenant-a/repositories/"+repositoryId+"/merge-operations/"+op+"/"+request+"/"+kind;bodies.set(key,bytes);
  return {tenantId:"tenant-a",repositoryId,operationId:op,requestSha256:request,kind,key,sha256:hash(bytes),sizeBytes:bytes.length,etag:hash(bytes),version:"version-a",expiresAt:null};
 }
 function source(role:"source_target_pack"|"source_head_pack",tip:string):StoredSourcePack {
  const repositoryId=role==="source_head_pack"?sourceRepositoryId:"repo-a";
  const op="source-"+role,publicInput={tenant_id:"tenant-a",repository_id:repositoryId,operation_id:op,fence_token:"source-fence",provider_repository:"namespace/repo",ref:"refs/heads/"+(role==="source_target_pack"?"main":"feature"),expected_oid:tip,role,output_dir:"/work/tenant-a/"+repositoryId+"/"+op+"/source-pack"};
  const request=hash(canonicalJson(publicInput)),bytes=new TextEncoder().encode("PACK "+role+" source object fixture stream");
  const text=JSON.stringify({frame:"gitfoundry.source-pack.manifest.v1",public:publicInput,request_sha256:request,pack:{filename:"source.pack",sha256:hash(bytes),size_bytes:bytes.length},git_version:"2.39.5"})+"\n";
  return {public:publicInput,manifest:locator(op,request,"source_manifest",new TextEncoder().encode(text),repositoryId),pack:locator(op,request,role,bytes,repositoryId)};
 }
 const sources={target:source("source_target_pack",base),head:source("source_head_pack",input.headSha),sourceRepositoryId};
 const store={async getVerified(l:ImmutableBlobLocator){const bytes=bodies.get(l.key)!;if(hash(bytes)!==l.sha256)throw new Error("artifact digest mismatch");return byteStream(bytes)},async putAppendOnly(i:CandidateArtifactInput){const bytes=new Uint8Array(await new Response(i.body).arrayBuffer());expect(hash(bytes)).toBe(i.expectedSha256);expect(bytes.length).toBe(i.expectedSizeBytes);stored.push(i);return locator(i.operationId,i.requestSha256,i.kind,bytes)}};
 const container={async exec(argv:string[],_options:ContainerExecOptions){calls.push(argv);let inputBytes=new Uint8Array();const output=new TransformStream<Uint8Array,Uint8Array>();let resolveExit!:(code:number)=>void;const exitCode=new Promise<number>(r=>resolveExit=r);
  const stdin=new WritableStream<Uint8Array>({write(bytes){const next=new Uint8Array(inputBytes.length+bytes.length);next.set(inputBytes);next.set(bytes,inputBytes.length);inputBytes=next},close(){
   let bytes:Uint8Array;
   if(argv[0]!.endsWith("gitfoundry-supervise")){bytes=new TextEncoder().encode("2.39.5\n")}
   else if(argv[0]!.endsWith("gitfoundry-hydrate-source")){const first=new TextDecoder().decode(inputBytes).split("\n")[0]!;const p=JSON.parse(first);bytes=new TextEncoder().encode(JSON.stringify({frame:"gitfoundry.source-hydrate.result.v1",ok:true,status:"hydrated",tenant_id:p.tenant_id,repository_id:p.repository_id,operation_id:p.operation_id,role:p.role,expected_oid:p.expected_oid,tip:p.expected_oid,pack_sha256:p.pack_sha256,pack_size_bytes:p.pack_size_bytes,request_sha256:argv.at(-1),git_version:"2.39.5"})+"\n")}
   else if(argv[1]==="compare-source"){const p=JSON.parse(new TextDecoder().decode(inputBytes).split("\n")[0]!);bytes=new TextEncoder().encode(JSON.stringify({frame:"gitfoundry.source-compare.result.v1",ok:true,status:"compared",tenant_id:p.tenant_id,repository_id:p.repository_id,operation_id:p.operation_id,pull_request_id:p.pull_request_id,pull_request_version:p.pull_request_version,head_sha:p.head_sha,base_sha:p.base_sha,algorithm_version:reviewedDiff.algorithm_version,comparison:reviewedDiff.comparison,context_lines:reviewedDiff.context_lines,merge_base_shas:reviewedDiff.merge_base_shas,patch_sha256:reviewedDiff.patch_sha256,patch_size_bytes:reviewedDiff.patch_size_bytes,changed_paths_sha256:reviewedDiff.changed_paths_sha256,git_version:"2.39.5",state_ref:"source-compare/requests/"+argv.at(-1)+"/manifest.json"})+"\n")}
   else if(argv[1]==="prepare")bytes=new TextEncoder().encode(JSON.stringify(result)+"\n");
   else if(argv[1]==="export-manifest")bytes=new TextEncoder().encode(JSON.stringify(manifest)+"\n");
   else bytes=argv[1]==="export-commit"?raw:pack;
   const writer=output.writable.getWriter();void writer.write(bytes).then(()=>writer.close()).then(()=>resolveExit(0));
  }});
  return {stdin,stdout:output.readable,stderr:byteStream(new Uint8Array()),exitCode,kill:vi.fn()};
 }};
 return {input,result,raw,manifest,sources,store,container,calls,stored,bodies};
}
describe("stored source to prepared candidate pipeline (platform fixture)",()=>{
 for(const method of ["merge","squash","rebase","fast_forward"] as const)it("hydrates both sources and captures original "+method+" candidate bytes",async()=>{
  const f=fixture(method);const prepared=await prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env);
  expect(prepared.result.ok).toBe(true);expect(prepared.candidate?.rawCommit.sha256).toBe(hash(f.raw));
  expect(f.calls.map(x=>x[1])).toEqual(["hydrate","hydrate","compare-source","prepare","export-manifest","export-commit","export-pack"]);
  expect(f.stored.map(x=>x.kind)).toEqual(["candidate_manifest","candidate_raw_commit","candidate_pack"]);
  expect(prepared.candidate?.result.candidateOid).toBe(f.result.candidate_oid);
 });
 it("rejects reviewed diff identity and shape substitutions before artifact capture",async()=>{
  for(const changed of [{head_sha:"5".repeat(40)},{base_sha:"5".repeat(40)},{algorithm_version:"invented"},{patch_size_bytes:1024*1024+1},{merge_base_shas:[]},{fresh:true}]) {
   const f=fixture();Object.assign(f.manifest.reviewed_diff,changed);
   await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/reviewed diff/);
   expect(f.stored).toEqual([]);
  }
 });
 it("hydrates an authorized fork head from its actual source repository",async()=>{const f=fixture("merge","repo-source");const prepared=await prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env);expect(prepared.result.ok).toBe(true);expect(f.sources.head.pack.repositoryId).toBe("repo-source");expect(prepared.candidate?.pack.repositoryId).toBe("repo-a")});
 it("rejects a source repository substituted against the authoritative PR",async()=>{const f=fixture("merge","repo-source");f.sources.sourceRepositoryId="another-repo";await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/source.*scope/);expect(f.calls).toEqual([])});
 it("rejects a foreign source identity before execution",async()=>{const f=fixture();f.sources.head={...f.sources.head,public:{...f.sources.head.public,tenant_id:"foreign"}};await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/source.*scope/);expect(f.calls).toEqual([])});
 it("rejects a substituted manifest before hydration",async()=>{const f=fixture();const key=f.sources.head.manifest.key;f.bodies.set(key,new TextEncoder().encode("{}\n"));await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/digest/);expect(f.calls).toEqual([])});
 it("rejects a missing or corrupt source pack before candidate preparation",async()=>{const f=fixture();f.bodies.set(f.sources.head.pack.key,new TextEncoder().encode("corrupt"));await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/digest/);expect(f.calls.some(x=>x[1]==="prepare")).toBe(false)});
 it("rejects manifest identity substitutions before storing candidate artifacts",async()=>{const f=fixture();f.manifest.head_sha="5".repeat(40);await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/candidate manifest/);expect(f.stored).toEqual([])});
 it("binds actual raw Git bytes to candidate OID independently of helper hashes",async()=>{const f=fixture();f.raw[f.raw.length-2]!^=1;f.manifest.candidate_bytes_sha256=hash(f.raw);f.result.candidate_bytes_sha256=hash(f.raw);await expect(prepareStoredMergeCandidate(f.container as unknown as Pick<Container,"exec">,f.input,f.sources,f.store,env)).rejects.toThrow(/raw candidate/);expect(f.stored.map(x=>x.kind)).toEqual(["candidate_manifest"])});
});

describe("private candidate runtime lifecycle (platform fixture)",()=>{
  it("persists real conflict diff in the strict helper wire receipt before cleanup and replay",async()=>{
   const f=fixture("merge","repo-source");
   const rawResult=f.result as unknown as Record<string,unknown>;
   for(const key of ["candidate_oid","candidate_tree","candidate_bytes_sha256","original_to_rebased"])delete rawResult[key];
   Object.assign(rawResult,{ok:false,status:"conflict",diagnostics:[{code:"merge_conflict",path:"src/shared.ts"}]});
   const {CandidateArtifactStore}=await import("./artifact-store.js");
   const {executeStoredMergeCandidate}=await import("../linux/execution.js");
   const read=vi.spyOn(CandidateArtifactStore.prototype,"getVerified").mockImplementation(f.store.getVerified);
   const write=vi.spyOn(CandidateArtifactStore.prototype,"putAppendOnly").mockImplementation(f.store.putAppendOnly);
   const values=new Map<string,unknown>();let running=false;let labels:Record<string,string>={};let destroyed=0;
   const expectedDiff={algorithmVersion:"git-cli-unified-v1",comparison:"three_dot",contextLines:3,headSha:f.input.headSha,baseSha:f.input.baseSha,mergeBaseShas:[f.input.baseSha],patchSha256:hash(""),patchSizeBytes:0,changedPathsSha256:hash("")};
   const storage={async get<T>(key:string){return values.get(key) as T|undefined},async put(key:string,value:unknown){values.set(key,value)},async delete(key:string){return values.delete(key)},async setAlarm(_value:number){},async deleteAlarm(){}};
   const container={...f.container,images:{gfy:"registry.example/helper@sha256:"+"a".repeat(64)},lastStart:undefined as ContainerStartupOptions|undefined,start(options:ContainerStartupOptions){this.lastStart=options;running=true;labels=options.labels??{}},async inspect(){return running?{image:this.lastStart?.image??"",labels}:null},async destroy(){expect(f.stored).toEqual([]);expect([...values.values()].some((value:any)=>value.reviewedDiff?.patchSha256===expectedDiff.patchSha256)).toBe(true);running=false;destroyed++}};
   try{
    const ctx={storage,container} as unknown as DurableObjectState;
    const nativeEnv={...env,GFY_ARTIFACTS:{} as R2Bucket,GFY_DB:{} as D1Database};
    const request={candidate:f.input,sources:f.sources};
    const response=await executeStoredMergeCandidate(ctx,nativeEnv,request);
    const first=await response.json() as any;
    expect(response.status).toBe(200);
    expect(first.receipt.status).toBe("failed");
    expect(parseMergeCandidateResult(first.receipt.stdout,f.input)).toMatchObject({ok:false,status:"conflict",diagnostics:[{code:"merge_conflict",path:"src/shared.ts"}]});
    expect(first.receipt.reviewedDiff).toEqual(expectedDiff);
    expect(first.receipt.mergeCandidate).toBeUndefined();
    const count=f.calls.length;
    const replay=await executeStoredMergeCandidate(ctx,nativeEnv,request);
    expect(await replay.json()).toMatchObject({replayed:true,receipt:{reviewedDiff:expectedDiff,stdout:first.receipt.stdout}});
    expect(f.calls.length).toBe(count);expect(destroyed).toBe(1);
   }finally{read.mockRestore();write.mockRestore()}
  });

 it("requires durable artifact bindings and refuses arbitrary caller fields before starting a container",async()=>{
  const f=fixture();
  const {executeStoredMergeCandidate}=await import("../linux/execution.js");
  const ctx={container:{exec:vi.fn()}} as unknown as DurableObjectState;
  const request={candidate:f.input,sources:f.sources};
  expect((await executeStoredMergeCandidate(ctx,env,request)).status).toBe(503);
  expect((await executeStoredMergeCandidate(ctx,env,{...request,argv:["/bin/sh"]})).status).toBe(400);
  expect((await executeStoredMergeCandidate(ctx,env,{...request,candidate:{...f.input,egressProfile:"gfy_internal_only"}})).status).toBe(400);
  expect(ctx.container!.exec).not.toHaveBeenCalled();
 });
 it("stores original candidate locators before cleanup and replays without running helpers again",async()=>{
  const f=fixture();
  const {CandidateArtifactStore}=await import("./artifact-store.js");
  const {executeStoredMergeCandidate}=await import("../linux/execution.js");
  const read=vi.spyOn(CandidateArtifactStore.prototype,"getVerified").mockImplementation(f.store.getVerified);
  const write=vi.spyOn(CandidateArtifactStore.prototype,"putAppendOnly").mockImplementation(f.store.putAppendOnly);
  const values=new Map<string,unknown>();let alarm:number|undefined;let running=false;let labels:Record<string,string>={};let destroyed=0;
  const storage={async get<T>(key:string){return values.get(key) as T|undefined},async put(key:string,value:unknown){values.set(key,value)},async delete(key:string){return values.delete(key)},async setAlarm(value:number){alarm=value},async deleteAlarm(){alarm=undefined}};
  const callsBefore=()=>f.calls.length;
  const container={...f.container,images:{gfy:"registry.example/helper@sha256:"+"a".repeat(64)},lastStart:undefined as ContainerStartupOptions|undefined,start(options:ContainerStartupOptions){expect(options.enableInternet).toBe(false);this.lastStart=options;running=true;labels=options.labels??{}},async inspect(){return running?{image:this.lastStart?.image??"",labels}:null},async destroy(){expect(f.stored.map(x=>x.kind)).toEqual(["candidate_manifest","candidate_raw_commit","candidate_pack"]);expect([...values.values()].some((v:any)=>v.mergeCandidate?.result.candidateOid===f.result.candidate_oid)).toBe(true);running=false;destroyed++},async interceptOutboundHttp(){throw new Error("offline candidate unexpectedly installed egress")},async interceptOutboundHttps(){throw new Error("offline candidate unexpectedly installed egress")}};
  try {
   const ctx={storage,container} as unknown as DurableObjectState;
   const nativeEnv={...env,GFY_ARTIFACTS:{} as R2Bucket,GFY_DB:{} as D1Database};
   const request={candidate:f.input,sources:f.sources};
   const response=await executeStoredMergeCandidate(ctx,nativeEnv,request);
   const first=await response.json() as any;
   expect(response.status).toBe(200);expect(first.receipt.status).toBe("succeeded");expect(first.receipt.egressProfile).toBe("deny_all");expect(first.receipt.mergeCandidate.result.candidateOid).toBe(f.result.candidate_oid);
   expect(parseMergeCandidateResult(first.receipt.stdout,f.input)).toEqual(first.receipt.mergeCandidate.result);
   expect(first.receipt.reviewedDiff).toEqual(first.receipt.mergeCandidate.reviewedDiff);
   expect(destroyed).toBe(1);expect(alarm).toBeUndefined();
   const count=callsBefore();const replay=await executeStoredMergeCandidate(ctx,nativeEnv,request);
   expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,receipt:{mergeCandidate:first.receipt.mergeCandidate}});
   expect(callsBefore()).toBe(count);expect(destroyed).toBe(1);
   const changed=await executeStoredMergeCandidate(ctx,nativeEnv,{...request,candidate:{...f.input,message:"Different candidate"}});
   expect(changed.status).toBe(409);expect(await changed.json()).toMatchObject({error:"gfy_candidate_replay_request_conflict"});
   const differentSources=await executeStoredMergeCandidate(ctx,nativeEnv,{...request,sources:{...f.sources,sourceRepositoryId:"another-repo"}});
   expect(differentSources.status).toBe(409);expect(callsBefore()).toBe(count);
  }finally{read.mockRestore();write.mockRestore()}
 });
});
