import { createHash } from "node:crypto";
import { buildMergeCandidateAdmission, parseMergeCandidateResult, type MergeCandidatePrepareInput, type MergeCandidateResult } from "./index.js";
import type { LinuxExecutionEnv } from "../linux/execution.js";
import type { CandidateArtifactStore, ImmutableBlobLocator } from "./artifact-store.js";
import { byteStream, canonicalJson, collectBoundedText, validateSourcePackManifest, type StoredSourcePack, type SourcePackFrame } from "./source-packs.js";

type PreparedResult = Extract<MergeCandidateResult, {ok:true}>;
type ArtifactPort = Pick<CandidateArtifactStore,"getVerified"|"putAppendOnly">;
export interface CandidateSources { readonly target:StoredSourcePack; readonly head:StoredSourcePack; readonly sourceRepositoryId:string }
export interface ReviewedDiffEvidence {
 readonly algorithmVersion:"git-cli-unified-v1"; readonly comparison:"three_dot"; readonly contextLines:3;
 readonly headSha:string; readonly baseSha:string; readonly mergeBaseShas:readonly string[];
 readonly patchSha256:string; readonly patchSizeBytes:number; readonly changedPathsSha256:string;
}
export interface StoredMergeCandidate {
 readonly requestSha256:string; readonly result:PreparedResult;
 readonly manifest:ImmutableBlobLocator; readonly rawCommit:ImmutableBlobLocator; readonly pack:ImmutableBlobLocator; readonly reviewedDiff:ReviewedDiffEvidence;
}
export interface PreparedCandidateOutcome { readonly result:MergeCandidateResult; readonly reviewedDiff?:ReviewedDiffEvidence; readonly candidate?:StoredMergeCandidate }
const maxPackBytes=128*1024*1024;
const hydrateFrame="gitfoundry.source-hydrate.v1";
const compareFrame="gitfoundry.source-compare.v1";
const candidateHelper="/usr/local/bin/gitfoundry-merge-candidate";
const sourcePublicKeys=["tenant_id","repository_id","operation_id","fence_token","provider_repository","ref","expected_oid","role","output_dir"];
const manifestKeys=["request_sha256","method","head_sha","base_sha","candidate_oid","candidate_tree","candidate_bytes_sha256","candidate_size_bytes","pack_size_bytes","candidate_parents","bundle_sha256","pack_file","git_version","observed_git_version","original_to_rebased","result","reviewed_diff"];

export async function prepareStoredMergeCandidate(
 container:Pick<Container,"exec">, input:MergeCandidatePrepareInput, sources:CandidateSources, store:ArtifactPort, env:LinuxExecutionEnv
):Promise<PreparedCandidateOutcome> {
 const frame=buildMergeCandidateAdmission(input,env);
 if(frame.admission.egressProfile!=="deny_all"||frame.admission.startup.enableInternet!==false)throw new Error("candidate preparation must be offline");
 // Validate both durable source identities and manifests before importing either pack.
 for(const [source,role,tip] of [[sources.target,"source_target_pack",input.baseSha],[sources.head,"source_head_pack",input.headSha]] as const) {
  validateStoredSource(source,input,role,tip,role==="source_target_pack"?input.repositoryId:sources.sourceRepositoryId);
  const manifestText=await collectBoundedText(await store.getVerified(source.manifest),65536);
  const expected:SourcePackFrame={public:source.public,requestSha256:source.pack.requestSha256,stdin:"",argv:[]};
  validateSourcePackManifest(manifestText,expected,{packSha256:source.pack.sha256,packSizeBytes:source.pack.sizeBytes,manifestSha256:source.manifest.sha256,gitVersion:"2.39.5"});
 }
 for(const source of [sources.target,sources.head]) {
  const body=await store.getVerified(source.pack);
  const request=buildSourceHydrationRequest(input,source);
  const process=await container.exec([...request.argv],{cwd:frame.admission.cwd,env:frame.admission.env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  const output=await runProcess(process,prepend(request.stdin,body),32768);
  assertHydrationResult(output.stdout,request.public,request.requestSha256);
 }
 const reviewedDiff=await compareSource(container,frame.admission.cwd,frame.admission.env,input);
 const prepareProcess=await container.exec([...frame.admission.argv],{cwd:frame.admission.cwd,env:frame.admission.env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const output=await runProcess(prepareProcess,byteStream(new TextEncoder().encode(frame.stdin)),32768);
 const result=parseMergeCandidateResult(output.stdout,input);
 if(!result.ok)return {result,reviewedDiff};
 const candidate=await captureCandidate(container,frame.admission.cwd,frame.admission.env,input,frame.stdin,frame.requestSha256,result,store,reviewedDiff);
 return {result,reviewedDiff,candidate};
}

export function buildSourceHydrationRequest(input:MergeCandidatePrepareInput,source:StoredSourcePack) {
 const publicInput={frame:hydrateFrame,tenant_id:input.tenantId,repository_id:input.repositoryId,operation_id:input.operationId,
  role:source.public.role,expected_oid:source.public.expected_oid,pack_sha256:source.pack.sha256,pack_size_bytes:source.pack.sizeBytes};
 const stdin=JSON.stringify(publicInput)+"\n",requestSha256=sha(stdin);
 return {public:publicInput,stdin,requestSha256,argv:["/usr/local/bin/gitfoundry-hydrate-source","hydrate","--request-format",hydrateFrame,"--request-sha256",requestSha256] as const};
}

function validateStoredSource(source:StoredSourcePack,input:MergeCandidatePrepareInput,role:"source_target_pack"|"source_head_pack",tip:string,repositoryId:string):void {
 if(typeof repositoryId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(repositoryId)||repositoryId.includes(".."))throw new Error("source repository identity invalid");
 if(!source||!record(source.public))throw new Error("source descriptor missing");
 exactKeys(source.public,sourcePublicKeys,"source");
 const p=source.public;
 if(p.tenant_id!==input.tenantId||p.repository_id!==repositoryId||p.role!==role||p.expected_oid!==tip)throw new Error("source descriptor scope or tip mismatch");
 for(const id of [p.operation_id,p.fence_token])if(typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id)||id.includes(".."))throw new Error("source operation identity invalid");
 if(p.output_dir!=="/work/"+input.tenantId+"/"+repositoryId+"/"+p.operation_id+"/source-pack")throw new Error("source output path mismatch");
 if(!/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/u.test(p.provider_repository)||typeof p.ref!=="string"||!p.ref.startsWith("refs/")||p.ref.includes("..")||p.ref.includes("@{")||/[\u0000-\u0020\u007f~^:?*\\[\]\\]/u.test(p.ref)||p.ref.split("/").some(part=>!part||part.startsWith(".")||part.endsWith(".")||part.endsWith(".lock")))throw new Error("source provider or ref invalid");
 const requestSha256=sha(canonicalJson(p));
 for(const [locator,kind] of [[source.manifest,"source_manifest"],[source.pack,role]] as const) {
  if(!locator||locator.tenantId!==input.tenantId||locator.repositoryId!==repositoryId||locator.operationId!==p.operation_id||locator.requestSha256!==requestSha256||locator.kind!==kind)throw new Error("source locator scope mismatch");
 }
 boundedInteger(source.pack.sizeBytes,32,maxPackBytes,"source pack size");
}
function assertHydrationResult(stdout:string,expected:ReturnType<typeof buildSourceHydrationRequest>["public"],requestSha256:string):void {
 const value=jsonLine(stdout);
 const fields={frame:"gitfoundry.source-hydrate.result.v1",ok:true,status:"hydrated",tenant_id:expected.tenant_id,repository_id:expected.repository_id,operation_id:expected.operation_id,role:expected.role,expected_oid:expected.expected_oid,tip:expected.expected_oid,pack_sha256:expected.pack_sha256,pack_size_bytes:expected.pack_size_bytes,request_sha256:requestSha256,git_version:"2.39.5"};
 exactKeys(value,Object.keys(fields),"source hydration");
 for(const [key,wanted] of Object.entries(fields))if(value[key]!==wanted)throw new Error("source hydration result mismatch: "+key);
}

function buildSourceCompareRequest(input:MergeCandidatePrepareInput) {
 const publicInput={frame:compareFrame,tenant_id:input.tenantId,repository_id:input.repositoryId,operation_id:input.operationId,pull_request_id:input.pullRequestId,pull_request_version:input.pullRequestVersion,head_sha:input.headSha,base_sha:input.baseSha,trusted_git_dir:"/work/"+input.tenantId+"/"+input.repositoryId+"/"+input.operationId+"/trusted-git",state_dir:"/work/"+input.tenantId+"/"+input.repositoryId+"/"+input.operationId+"/source-compare",algorithm_version:"git-cli-unified-v1",comparison:"three_dot",context_lines:3,git_version:"2.39.5"};
 const stdin=JSON.stringify(publicInput)+"\n",requestSha256=sha(stdin);
 return {public:publicInput,stdin,requestSha256,argv:[candidateHelper,"compare-source","--request-format",compareFrame,"--request-sha256",requestSha256] as const};
}

async function compareSource(container:Pick<Container,"exec">,cwd:string,env:Record<string,string>,input:MergeCandidatePrepareInput):Promise<ReviewedDiffEvidence> {
 const request=buildSourceCompareRequest(input);
 const process=await container.exec([...request.argv],{cwd,env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const output=await runProcess(process,byteStream(new TextEncoder().encode(request.stdin)),32768);
 return assertSourceCompareResult(output.stdout,request.public,request.requestSha256,input);
}

function assertSourceCompareResult(stdout:string,expected:ReturnType<typeof buildSourceCompareRequest>["public"],requestSha256:string,input:MergeCandidatePrepareInput):ReviewedDiffEvidence {
 const value=jsonLine(stdout);
 exactKeys(value,["algorithm_version","base_sha","changed_paths_sha256","comparison","context_lines","frame","git_version","head_sha","merge_base_shas","ok","operation_id","patch_sha256","patch_size_bytes","pull_request_id","pull_request_version","repository_id","state_ref","status","tenant_id"],"source compare");
 const fields={frame:"gitfoundry.source-compare.result.v1",ok:true,status:"compared",tenant_id:expected.tenant_id,repository_id:expected.repository_id,operation_id:expected.operation_id,pull_request_id:expected.pull_request_id,pull_request_version:expected.pull_request_version,head_sha:expected.head_sha,base_sha:expected.base_sha,algorithm_version:"git-cli-unified-v1",comparison:"three_dot",context_lines:3,git_version:"2.39.5",state_ref:"source-compare/requests/"+requestSha256+"/manifest.json"};
 for(const [key,wanted] of Object.entries(fields))if(value[key]!==wanted)throw new Error("source compare result mismatch: "+key);
 return validateReviewedDiffEvidence({algorithm_version:value.algorithm_version,comparison:value.comparison,context_lines:value.context_lines,head_sha:value.head_sha,base_sha:value.base_sha,merge_base_shas:value.merge_base_shas,patch_sha256:value.patch_sha256,patch_size_bytes:value.patch_size_bytes,changed_paths_sha256:value.changed_paths_sha256},input);
}

async function captureCandidate(container:Pick<Container,"exec">,cwd:string,env:Record<string,string>,input:MergeCandidatePrepareInput,stdin:string,requestSha256:string,result:PreparedResult,store:ArtifactPort,expectedReviewedDiff:ReviewedDiffEvidence):Promise<StoredMergeCandidate> {
 const manifestProcess=await exportProcess(container,cwd,env,"export-manifest",requestSha256,stdin);
 const output=await runProcess(manifestProcess,byteStream(new TextEncoder().encode(stdin)),65536);
 const value=jsonLine(output.stdout);exactKeys(value,manifestKeys,"candidate manifest");
 const common={request_sha256:requestSha256,method:input.method,head_sha:input.headSha,base_sha:input.baseSha,candidate_oid:result.candidateOid,candidate_tree:result.candidateTree,candidate_bytes_sha256:result.candidateBytesSha256,git_version:result.gitVersion};
 for(const [key,wanted] of Object.entries(common))if(value[key]!==wanted)throw new Error("candidate manifest identity mismatch: "+key);
 const nested=parseMergeCandidateResult(JSON.stringify(value.result)+"\n",input);
 if(canonicalJson(nested)!==canonicalJson(result)||canonicalJson(value.original_to_rebased)!==canonicalJson(result.originalToRebased))throw new Error("candidate manifest result mismatch");
 if(result.stateRef!=="merge-candidates/requests/"+requestSha256+"/manifest.json")throw new Error("candidate manifest state mismatch");
 if(typeof value.observed_git_version!=="string"||value.observed_git_version!=="git version 2.39.5")throw new Error("candidate manifest Git version mismatch");
 if(!Array.isArray(value.candidate_parents)||value.candidate_parents.length>64||value.candidate_parents.some(parent=>typeof parent!=="string"||!/^[0-9a-f]{40}$/u.test(parent)))throw new Error("candidate manifest parents invalid");
 const reviewedDiff=validateReviewedDiffEvidence(value.reviewed_diff,input);
 if(canonicalJson(reviewedDiff)!==canonicalJson(expectedReviewedDiff))throw new Error("candidate reviewed diff mismatch");
 const rawSize=boundedInteger(value.candidate_size_bytes,1,8*1024*1024,"candidate raw size");
 const packSize=boundedInteger(value.pack_size_bytes,32,maxPackBytes,"candidate pack size");
 const packSha=digest(value.bundle_sha256);
 const prefix="/work/"+input.tenantId+"/"+input.repositoryId+"/"+input.operationId+"/merge-candidates/requests/"+requestSha256+"/candidate-pack-";
 if(typeof value.pack_file!=="string"||!value.pack_file.startsWith(prefix)||!/^[0-9a-f]{40}\.pack$/u.test(value.pack_file.slice(prefix.length)))throw new Error("candidate manifest pack path mismatch");
 const scope={tenantId:input.tenantId,repositoryId:input.repositoryId,operationId:input.operationId,requestSha256,expiresAt:null};
 const manifestBytes=new TextEncoder().encode(output.stdout);
 const manifest=await store.putAppendOnly({...scope,kind:"candidate_manifest",body:byteStream(manifestBytes),expectedSha256:sha(manifestBytes),expectedSizeBytes:manifestBytes.length,contentType:"application/json"});
 const rawProcess=await exportProcess(container,cwd,env,"export-commit",requestSha256,stdin);
 const rawCommit=await captureBinary(rawProcess,stdin,store,{...scope,kind:"candidate_raw_commit",expectedSha256:result.candidateBytesSha256,expectedSizeBytes:rawSize,contentType:"application/octet-stream"},result);
 const packProcess=await exportProcess(container,cwd,env,"export-pack",requestSha256,stdin);
 const pack=await captureBinary(packProcess,stdin,store,{...scope,kind:"candidate_pack",expectedSha256:packSha,expectedSizeBytes:packSize,contentType:"application/octet-stream"});
 return {requestSha256,result,manifest,rawCommit,pack,reviewedDiff};
}
export function validateReviewedDiffEvidence(value:unknown,input:Pick<MergeCandidatePrepareInput,"headSha"|"baseSha">):ReviewedDiffEvidence {
 if(!record(value))throw new Error("reviewed diff evidence missing");
 exactKeys(value,["algorithm_version","comparison","context_lines","head_sha","base_sha","merge_base_shas","patch_sha256","patch_size_bytes","changed_paths_sha256"],"reviewed diff");
 if(value.algorithm_version!=="git-cli-unified-v1"||value.comparison!=="three_dot"||value.context_lines!==3||value.head_sha!==input.headSha||value.base_sha!==input.baseSha)throw new Error("reviewed diff evidence identity mismatch");
 if(!Array.isArray(value.merge_base_shas)||value.merge_base_shas.length<1||value.merge_base_shas.length>64||new Set(value.merge_base_shas).size!==value.merge_base_shas.length||value.merge_base_shas.some(oid=>typeof oid!=="string"||!/^[0-9a-f]{40}$/u.test(oid)))throw new Error("reviewed diff merge bases invalid");
 return {algorithmVersion:"git-cli-unified-v1",comparison:"three_dot",contextLines:3,headSha:input.headSha,baseSha:input.baseSha,mergeBaseShas:[...value.merge_base_shas],patchSha256:digest(value.patch_sha256),patchSizeBytes:boundedInteger(value.patch_size_bytes,0,1024*1024,"reviewed diff patch size"),changedPathsSha256:digest(value.changed_paths_sha256)};
}
async function exportProcess(container:Pick<Container,"exec">,cwd:string,env:Record<string,string>,command:string,requestSha:string,_stdin:string):Promise<ExecProcess> {
 return container.exec([candidateHelper,command,"--request-format","gitfoundry.merge-candidate.prepare.v1","--request-sha256",requestSha],{cwd,env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
}
async function captureBinary(process:ExecProcess,stdin:string,store:ArtifactPort,input:Omit<Parameters<ArtifactPort["putAppendOnly"]>[0],"body">,raw?:PreparedResult):Promise<ImmutableBlobLocator> {
 if(!process.stdout)throw new Error("candidate export stdout missing");
 const body=raw?verifyRawCommit(process.stdout,input.expectedSizeBytes,raw):process.stdout;
 const [locator,stderr,exit]=await Promise.all([store.putAppendOnly({...input,body}),collectBoundedText(process.stderr,32768),process.exitCode,pipeInput(process,byteStream(new TextEncoder().encode(stdin)))]);
 if(exit!==0)throw new Error("candidate export failed: "+stderr);
 return locator;
}
function verifyRawCommit(body:ReadableStream<Uint8Array>,size:number,result:PreparedResult):ReadableStream<Uint8Array> {
 const hash=createHash("sha1").update("commit "+size+"\0");
 const expectedPrefix=new TextEncoder().encode("tree "+result.candidateTree+"\n");let prefixOffset=0;
 return body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
  transform(bytes,c){for(let i=0;i<bytes.length&&prefixOffset<expectedPrefix.length;i++,prefixOffset++)if(bytes[i]!==expectedPrefix[prefixOffset])throw new Error("raw candidate tree mismatch");hash.update(bytes);c.enqueue(bytes)},
  flush(){if(prefixOffset!==expectedPrefix.length||hash.digest("hex")!==result.candidateOid)throw new Error("raw candidate Git OID mismatch")}
 }));
}
async function runProcess(process:ExecProcess,input:ReadableStream<Uint8Array>,limit:number):Promise<{stdout:string;stderr:string}> {
 const [stdout,stderr,exit]=await Promise.all([collectBoundedText(process.stdout,limit),collectBoundedText(process.stderr,32768),process.exitCode,pipeInput(process,input)]);
 if(exit!==0)throw new Error("candidate helper process failed: "+stderr);
 return {stdout,stderr};
}
async function pipeInput(process:ExecProcess,input:ReadableStream<Uint8Array>):Promise<void> {
 if(!process.stdin)throw new Error("candidate helper stdin missing");
 try {await input.pipeTo(process.stdin)}catch(error){try{process.kill()}catch{}throw error}
}
function prepend(header:string,body:ReadableStream<Uint8Array>):ReadableStream<Uint8Array> {
 const reader=body.getReader();let sent=false;
 return new ReadableStream({async pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode(header));return}const next=await reader.read();if(next.done){reader.releaseLock();c.close()}else c.enqueue(next.value)},async cancel(reason){await reader.cancel(reason);reader.releaseLock()}});
}
function jsonLine(text:string):Record<string,unknown> {const lines=text.split("\n").filter(line=>line.trim());if(lines.length!==1)throw new Error("candidate helper must emit one JSON line");const value:unknown=JSON.parse(lines[0]!);if(!record(value))throw new Error("candidate helper object missing");return value}
function record(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function exactKeys(value:object,keys:readonly string[],label:string):void {if(Object.keys(value).sort().join("\0")!==[...keys].sort().join("\0"))throw new Error(label+" fields invalid")}
function boundedInteger(value:unknown,min:number,max:number,label:string):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<min||value>max)throw new Error(label+" outside bound");return value}
function sha(value:string|Uint8Array):string{return createHash("sha256").update(value).digest("hex")}
function digest(value:unknown):string{if(typeof value!=="string"||!/^[0-9a-f]{64}$/u.test(value))throw new Error("candidate manifest digest invalid");return value}
