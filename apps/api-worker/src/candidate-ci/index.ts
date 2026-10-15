import { createHash } from "node:crypto";
import type { ImmutableBlobLocator } from "../merge-candidate/artifact-store.js";
import type { ReviewedDiffEvidence, StoredMergeCandidate } from "../merge-candidate/pipeline.js";

export interface CandidateCiPlan { readonly planId:string; readonly policySha256:string; readonly planDigest:string; readonly scriptPath:string }
export interface StoredCandidateCiRequest {
  readonly commandId:string; readonly tenantId:string; readonly repositoryId:string; readonly sourceRepositoryId:string; readonly operationId:string; readonly eligibilityOperationId:string; readonly eligibilityGeneration:number;
  readonly pullRequestId:string; readonly pullRequestVersion:number; readonly issueVersion:number; readonly producerId:string; readonly producerAuthEpoch:number; readonly tenantPolicyEpoch:number;
  readonly jobId:string; readonly attemptId:string; readonly attemptGeneration:number; readonly fenceToken:string; readonly context:string; readonly imageDigest:string; readonly deadlineMs:number;
  readonly headSha:string; readonly baseSha:string; readonly candidateSha:string; readonly candidate:StoredMergeCandidate; readonly plan:CandidateCiPlan;
}
export interface CandidateCiBinding {
  readonly planId:string; readonly policySha256:string; readonly planDigest:string; readonly scriptPath:string; readonly context:string;
  readonly jobId:string; readonly attemptId:string; readonly attemptGeneration:number; readonly sourceRepositoryId:string; readonly pullRequestId:string; readonly pullRequestVersion:number; readonly issueVersion:number;
  readonly eligibilityOperationId:string; readonly eligibilityGeneration:number; readonly producerId:string; readonly producerAuthEpoch:number; readonly tenantPolicyEpoch:number; readonly imageDigest:string;
  readonly headSha:string; readonly baseSha:string; readonly candidateSha:string; readonly candidateTreeSha:string; readonly candidateRequestSha256:string;
  readonly manifestSha256:string; readonly packSha256:string; readonly rawCommitSha256:string; readonly reviewedDiffSha256:string;
}
export interface CandidateCiAdmissionParts { readonly request:StoredCandidateCiRequest; readonly requestSha256:string; readonly linuxRequest:Record<string,unknown>; readonly binding:CandidateCiBinding }
export interface CandidateCiRunResult { readonly status:"succeeded"|"failed"; readonly exitCode:number; readonly stdout:{readonly text:string;readonly truncated:boolean}; readonly stderr:{readonly text:string;readonly truncated:boolean}; readonly binding:CandidateCiBinding }

type ArtifactReader = { getVerified(locator:ImmutableBlobLocator):Promise<ReadableStream<Uint8Array>> };
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const contextPattern=/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const oidPattern=/^[0-9a-f]{40}$/u;
const digestPattern=/^[0-9a-f]{64}$/u;
const imageDigestPattern=/^sha256:[0-9a-f]{64}$/u;
const maxPackBytes=128*1024*1024;
const maxManifestBytes=64*1024;
const maxRawCommitBytes=8*1024*1024;
const defaultMaxOutputBytes=256*1024;
const manifestKeys=["request_sha256","method","head_sha","base_sha","candidate_oid","candidate_tree","candidate_bytes_sha256","candidate_size_bytes","pack_size_bytes","candidate_parents","bundle_sha256","pack_file","git_version","observed_git_version","original_to_rebased","result","reviewed_diff"];

export function buildCandidateCiAdmission(input:unknown):CandidateCiAdmissionParts {
  const request=parseStoredCandidateCiRequest(input);
  const binding=bindCandidate(request);
  const cwd=`/work/${request.tenantId}/${request.repositoryId}/${request.operationId}/ci-worktree`;
  const linuxRequest={commandId:request.commandId,tenantId:request.tenantId,repositoryId:request.repositoryId,operationId:request.operationId,fenceToken:request.fenceToken,deadlineMs:request.deadlineMs,cwd,argv:["/usr/local/bin/gitfoundry-ci-step","./"+request.plan.scriptPath],env:{CI:"true",GFY_COMMAND_ID:request.commandId,GFY_OPERATION_ID:request.operationId},egressProfile:"deny_all",expectedOldOid:request.baseSha,candidateNewOid:request.candidateSha,policyEpoch:request.tenantPolicyEpoch};
  const requestSha256=sha(canonicalCandidateCiRequest(request));
  return {request,requestSha256,linuxRequest,binding};
}

export function canonicalCandidateCiRequest(request:StoredCandidateCiRequest):string {
  return canonicalJson({attemptGeneration:request.attemptGeneration,attemptId:request.attemptId,baseSha:request.baseSha,candidateRequestSha256:request.candidate.requestSha256,candidateSha:request.candidateSha,commandId:request.commandId,context:request.context,deadlineMs:request.deadlineMs,eligibilityGeneration:request.eligibilityGeneration,eligibilityOperationId:request.eligibilityOperationId,fenceToken:request.fenceToken,headSha:request.headSha,imageDigest:request.imageDigest,issueVersion:request.issueVersion,jobId:request.jobId,operationId:request.operationId,plan:request.plan,producerAuthEpoch:request.producerAuthEpoch,producerId:request.producerId,pullRequestId:request.pullRequestId,pullRequestVersion:request.pullRequestVersion,repositoryId:request.repositoryId,sourceRepositoryId:request.sourceRepositoryId,tenantId:request.tenantId,tenantPolicyEpoch:request.tenantPolicyEpoch,artifacts:{manifest:locatorIdentity(request.candidate.manifest),pack:locatorIdentity(request.candidate.pack),rawCommit:locatorIdentity(request.candidate.rawCommit)}});
}

export async function runCandidateCi(container:Pick<Container,"exec">, parts:CandidateCiAdmissionParts, store:ArtifactReader, execution:{readonly env:Record<string,string>;readonly supervisorArgv:readonly string[];readonly cwd:string}, maxOutputBytes=defaultMaxOutputBytes):Promise<CandidateCiRunResult> {
  const manifestBytes=await collectBytes(await store.getVerified(parts.request.candidate.manifest),maxManifestBytes,"candidate manifest");
  validateCandidateManifest(parts.request,manifestBytes);
  const raw=await collectBytes(await store.getVerified(parts.request.candidate.rawCommit), maxRawCommitBytes, "candidate raw commit");
  if (sha(raw)!==parts.binding.rawCommitSha256||sha(raw)!==parts.request.candidate.result.candidateBytesSha256) throw new Error("candidate raw commit digest mismatch");
  if (gitObjectId("commit",raw)!==parts.request.candidateSha) throw new Error("candidate raw commit Git OID mismatch");
  const packStream=await store.getVerified(parts.request.candidate.pack);
  await materializeCandidate(container, parts, packStream, execution.env);
  const proc=await container.exec([...execution.supervisorArgv],{cwd:execution.cwd,env:execution.env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  await writeInput(proc.stdin,"");
  const [stdout,stderr,exitCode]=await Promise.all([collectText(proc.stdout,maxOutputBytes),collectText(proc.stderr,maxOutputBytes),proc.exitCode]);
  return {status:exitCode===0?"succeeded":"failed",exitCode,stdout,stderr,binding:parts.binding};
}

async function materializeCandidate(container:Pick<Container,"exec">, parts:CandidateCiAdmissionParts, pack:ReadableStream<Uint8Array>, env:Record<string,string>):Promise<void> {
  const r=parts.request,b=parts.binding;
  const opRoot=`/work/${r.tenantId}/${r.repositoryId}/${r.operationId}`;
  const repo=`${opRoot}/candidate.git`,worktree=`${opRoot}/ci-worktree`,tmp=`${opRoot}/candidate.pack`,raw=`${opRoot}/candidate.commit`;
  const script=[
    "set -eu",
    "test \"$(git --version)\" = 'git version 2.39.5'",
    `rm -rf ${q(repo)} ${q(worktree)} ${q(tmp)} ${q(raw)}`,
    `mkdir -p ${q(repo)} ${q(worktree)}`,
    `git init -q ${q(repo)}`,
    `cat > ${q(tmp)}`,
    `test \"$(sha256sum ${q(tmp)} | awk '{print $1}')\" = ${q(b.packSha256)}`,
    `test \"$(wc -c < ${q(tmp)} | tr -d ' ')\" = ${q(String(r.candidate.pack.sizeBytes))}`,
    `git -C ${q(repo)} unpack-objects < ${q(tmp)}`,
    `git -C ${q(repo)} cat-file commit ${q(r.candidateSha)} > ${q(raw)}`,
    `test \"$(sha256sum ${q(raw)} | awk '{print $1}')\" = ${q(b.rawCommitSha256)}`,
    `test \"$(git hash-object -t commit ${q(raw)})\" = ${q(r.candidateSha)}`,
    `test \"$(git -C ${q(repo)} show -s --format=%T ${q(r.candidateSha)})\" = ${q(b.candidateTreeSha)}`,
    `GIT_WORK_TREE=${q(worktree)} git -C ${q(repo)} checkout -f ${q(r.candidateSha)} -- .`,
    `test -x ${q(worktree+"/"+r.plan.scriptPath)}`,
    `printf '{"ok":true,"candidate":"%s","tree":"%s"}\\n' ${q(r.candidateSha)} ${q(b.candidateTreeSha)}`
  ].join("\n");
  const proc=await container.exec(["/bin/sh","-c",script],{cwd:"/work",env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  await pipeInput(proc.stdin, pack);
  const [stdout,stderr,exitCode]=await Promise.all([collectText(proc.stdout,32768),collectText(proc.stderr,32768),proc.exitCode]);
  if(exitCode!==0)throw new Error("candidate materialization failed: "+stdout.text+stderr.text);
}

function parseStoredCandidateCiRequest(input:unknown):StoredCandidateCiRequest {
  if(!record(input))throw new Error("candidate CI request must be an object");
  exact(input,["attemptGeneration","attemptId","baseSha","candidate","candidateSha","commandId","context","deadlineMs","eligibilityGeneration","eligibilityOperationId","fenceToken","headSha","imageDigest","issueVersion","jobId","operationId","plan","producerAuthEpoch","producerId","pullRequestId","pullRequestVersion","repositoryId","sourceRepositoryId","tenantId","tenantPolicyEpoch"],"candidate CI request");
  const request=input as unknown as StoredCandidateCiRequest;
  for(const [name,value] of [["commandId",request.commandId],["tenantId",request.tenantId],["repositoryId",request.repositoryId],["sourceRepositoryId",request.sourceRepositoryId],["operationId",request.operationId],["eligibilityOperationId",request.eligibilityOperationId],["fenceToken",request.fenceToken],["jobId",request.jobId],["attemptId",request.attemptId],["pullRequestId",request.pullRequestId],["producerId",request.producerId]] as const)if(typeof value!=="string"||!idPattern.test(value)||value.includes(".."))throw new Error(`${name} invalid`);
  for(const [name,value] of [["headSha",request.headSha],["baseSha",request.baseSha],["candidateSha",request.candidateSha]] as const)if(typeof value!=="string"||!oidPattern.test(value)||value==="0".repeat(40))throw new Error(`${name} invalid`);
  for(const [name,value] of [["eligibilityGeneration",request.eligibilityGeneration],["pullRequestVersion",request.pullRequestVersion],["issueVersion",request.issueVersion],["producerAuthEpoch",request.producerAuthEpoch],["tenantPolicyEpoch",request.tenantPolicyEpoch],["attemptGeneration",request.attemptGeneration]] as const)if(!Number.isSafeInteger(value)||value<1||value>1_000_000)throw new Error(`${name} invalid`);
  if(typeof request.context!=="string"||!contextPattern.test(request.context)||request.context.includes(".."))throw new Error("candidate CI context invalid");
  if(typeof request.imageDigest!=="string"||!imageDigestPattern.test(request.imageDigest))throw new Error("candidate CI image digest invalid");
  if(!Number.isInteger(request.deadlineMs)||request.deadlineMs<1||request.deadlineMs>120000)throw new Error("candidate CI deadline invalid");
  if(!record(request.plan))throw new Error("candidate CI plan missing");
  exact(request.plan,["planDigest","planId","policySha256","scriptPath"],"candidate CI plan");
  if(typeof request.plan.planId!=="string"||!idPattern.test(request.plan.planId)||!digestPattern.test(request.plan.policySha256)||!digestPattern.test(request.plan.planDigest))throw new Error("candidate CI plan identity invalid");
  if(typeof request.plan.scriptPath!=="string"||!/^\.gitfoundry\/[A-Za-z0-9_.\/-]{1,120}$/u.test(request.plan.scriptPath)||request.plan.scriptPath.includes("..")||request.plan.scriptPath.startsWith("/"))throw new Error("candidate CI script path invalid");
  validateCandidate(request);
  return request;
}

function validateCandidate(request:StoredCandidateCiRequest):void {
  const c=request.candidate;
  if(!record(c)||!record(c.result))throw new Error("candidate artifacts missing");
  if(c.requestSha256!==c.result.stateRef?.match(/^merge-candidates\/requests\/([0-9a-f]{64})\/manifest\.json$/u)?.[1])throw new Error("candidate request state mismatch");
  if(c.result.ok!==true||c.result.candidateOid!==request.candidateSha||typeof c.result.candidateTree!=="string"||!oidPattern.test(c.result.candidateTree)||typeof c.result.candidateBytesSha256!=="string"||!digestPattern.test(c.result.candidateBytesSha256))throw new Error("candidate result identity mismatch");
  if(!record(c.reviewedDiff)||c.reviewedDiff.headSha!==request.headSha||c.reviewedDiff.baseSha!==request.baseSha)throw new Error("candidate reviewed diff identity mismatch");
  for(const [locator,kind] of [[c.manifest,"candidate_manifest"],[c.rawCommit,"candidate_raw_commit"],[c.pack,"candidate_pack"]] as const)validateLocator(locator as ImmutableBlobLocator,kind as ImmutableBlobLocator["kind"],request,c.requestSha256);
}

function validateCandidateManifest(request:StoredCandidateCiRequest, manifestBytes:Uint8Array):void {
  if(sha(manifestBytes)!==request.candidate.manifest.sha256||manifestBytes.byteLength!==request.candidate.manifest.sizeBytes)throw new Error("candidate manifest digest mismatch");
  const value=jsonLine(new TextDecoder().decode(manifestBytes));
  exact(value,manifestKeys,"candidate manifest");
  const c=request.candidate;
  const common={request_sha256:c.requestSha256,head_sha:request.headSha,base_sha:request.baseSha,candidate_oid:request.candidateSha,candidate_tree:c.result.candidateTree,candidate_bytes_sha256:c.result.candidateBytesSha256,candidate_size_bytes:c.rawCommit.sizeBytes,pack_size_bytes:c.pack.sizeBytes,bundle_sha256:c.pack.sha256,git_version:c.result.gitVersion,observed_git_version:"git version 2.39.5"};
  for(const [key,wanted] of Object.entries(common))if(value[key]!==wanted)throw new Error("candidate manifest identity mismatch: "+key);
  if(value.candidate_bytes_sha256!==c.rawCommit.sha256)throw new Error("candidate bytes digest not bound to raw commit artifact");
  if(!["merge","squash","rebase","fast_forward"].includes(String(value.method)))throw new Error("candidate manifest method invalid");
  if(!Array.isArray(value.candidate_parents)||value.candidate_parents.some(parent=>typeof parent!=="string"||!oidPattern.test(parent)))throw new Error("candidate manifest parents invalid");
  if(!record(value.result)||value.result.ok!==true||value.result.candidate_oid!==request.candidateSha||value.result.candidate_tree!==c.result.candidateTree||value.result.candidate_bytes_sha256!==c.result.candidateBytesSha256||value.result.git_version!==c.result.gitVersion||value.result.state_ref!==c.result.stateRef)throw new Error("candidate manifest result mismatch");
  if(canonicalJson(value.result.original_to_rebased??[])!==canonicalJson(c.result.originalToRebased))throw new Error("candidate manifest rebase map mismatch");
  if(canonicalJson(camelReviewedDiff(value.reviewed_diff))!==canonicalJson(c.reviewedDiff))throw new Error("candidate manifest reviewed diff mismatch");
}

function bindCandidate(request:StoredCandidateCiRequest):CandidateCiBinding {
  return {planId:request.plan.planId,policySha256:request.plan.policySha256,planDigest:request.plan.planDigest,scriptPath:request.plan.scriptPath,context:request.context,jobId:request.jobId,attemptId:request.attemptId,attemptGeneration:request.attemptGeneration,sourceRepositoryId:request.sourceRepositoryId,pullRequestId:request.pullRequestId,pullRequestVersion:request.pullRequestVersion,issueVersion:request.issueVersion,eligibilityOperationId:request.eligibilityOperationId,eligibilityGeneration:request.eligibilityGeneration,producerId:request.producerId,producerAuthEpoch:request.producerAuthEpoch,tenantPolicyEpoch:request.tenantPolicyEpoch,imageDigest:request.imageDigest,headSha:request.headSha,baseSha:request.baseSha,candidateSha:request.candidateSha,candidateTreeSha:request.candidate.result.candidateTree,candidateRequestSha256:request.candidate.requestSha256,manifestSha256:request.candidate.manifest.sha256,packSha256:request.candidate.pack.sha256,rawCommitSha256:request.candidate.rawCommit.sha256,reviewedDiffSha256:sha(canonicalJson(request.candidate.reviewedDiff))};
}

function validateLocator(locator:ImmutableBlobLocator,kind:ImmutableBlobLocator["kind"],request:StoredCandidateCiRequest,requestSha256:string):void {
  if(!record(locator)||locator.tenantId!==request.tenantId||locator.repositoryId!==request.repositoryId||locator.operationId!==request.operationId||locator.requestSha256!==requestSha256||locator.kind!==kind)throw new Error("candidate artifact locator scope mismatch");
  if(!digestPattern.test(locator.sha256)||!Number.isSafeInteger(locator.sizeBytes)||locator.sizeBytes<0||locator.sizeBytes>maxPackBytes||typeof locator.etag!=="string"||typeof locator.version!=="string"||locator.expiresAt!==null)throw new Error("candidate artifact locator invalid");
  const key=`v1/tenants/${locator.tenantId}/repositories/${locator.repositoryId}/merge-operations/${locator.operationId}/${locator.requestSha256}/${locator.kind}`;
  if(locator.key!==key)throw new Error("candidate artifact locator key mismatch");
}

function locatorIdentity(locator:ImmutableBlobLocator):unknown{return {etag:locator.etag,expiresAt:locator.expiresAt,key:locator.key,kind:locator.kind,operationId:locator.operationId,repositoryId:locator.repositoryId,requestSha256:locator.requestSha256,sha256:locator.sha256,sizeBytes:locator.sizeBytes,tenantId:locator.tenantId,version:locator.version}}
function camelReviewedDiff(value:unknown):ReviewedDiffEvidence{if(!record(value))throw new Error("candidate manifest reviewed diff missing");if(value.algorithm_version!=="git-cli-unified-v1"||value.comparison!=="three_dot"||value.context_lines!==3)throw new Error("candidate manifest reviewed diff mode mismatch");return {algorithmVersion:"git-cli-unified-v1",comparison:"three_dot",contextLines:3,headSha:String(value.head_sha),baseSha:String(value.base_sha),mergeBaseShas:Array.isArray(value.merge_base_shas)?value.merge_base_shas.map(String):[],patchSha256:String(value.patch_sha256),patchSizeBytes:Number(value.patch_size_bytes),changedPathsSha256:String(value.changed_paths_sha256)}}
async function collectBytes(stream:ReadableStream<Uint8Array>, max:number, label:string):Promise<Uint8Array>{const reader=stream.getReader();const chunks:Uint8Array[]=[];let total=0;try{for(;;){const next=await reader.read();if(next.done)break;const chunk=next.value;if(!(chunk instanceof Uint8Array))throw new Error(label+" stream invalid");total+=chunk.byteLength;if(total>max)throw new Error(label+" outside bound");chunks.push(chunk)}}finally{reader.releaseLock()}const out=new Uint8Array(total);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.byteLength}return out}
async function collectText(stream:ReadableStream|null,max:number):Promise<{readonly text:string;readonly truncated:boolean}>{if(!stream)return {text:"",truncated:false};const reader=stream.getReader();const chunks:Uint8Array[]=[];let total=0;let truncated=false;try{for(;;){const next=await reader.read();if(next.done)break;const chunk=next.value instanceof Uint8Array?next.value:new TextEncoder().encode(String(next.value));if(total+chunk.byteLength<=max){chunks.push(chunk);total+=chunk.byteLength}else{const remain=Math.max(0,max-total);if(remain>0){chunks.push(chunk.slice(0,remain));total+=remain}truncated=true}}}finally{reader.releaseLock()}const out=new Uint8Array(total);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.byteLength}return {text:new TextDecoder().decode(out),truncated}}
async function writeInput(stdin:WritableStream|null,input:string):Promise<void>{if(!stdin)return;const writer=stdin.getWriter();try{if(input)await writer.write(new TextEncoder().encode(input));await writer.close()}finally{writer.releaseLock()}}
async function pipeInput(stdin:WritableStream|null,input:ReadableStream<Uint8Array>):Promise<void>{if(!stdin)throw new Error("candidate materialization stdin unavailable");await input.pipeTo(stdin)}
function gitObjectId(type:string,body:Uint8Array):string{return createHash("sha1").update(`${type} ${body.byteLength}\0`).update(body).digest("hex")}
function sha(value:string|Uint8Array):string{return createHash("sha256").update(value).digest("hex")}
function jsonLine(text:string):Record<string,unknown>{const trimmed=text.trimEnd();if(!trimmed||trimmed.includes("\n"))throw new Error("candidate manifest must be one JSON line");const value=JSON.parse(trimmed) as unknown;if(!record(value))throw new Error("candidate manifest must be object");return value}
function canonicalJson(value:unknown):string{if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(",")}}`;return JSON.stringify(value)}
function q(value:string):string{return `'${value.replaceAll("'","'\\''")}'`}
function exact(value:Record<string,unknown>,keys:readonly string[],label:string):void{if(Object.keys(value).sort().join("\0")!==[...keys].sort().join("\0"))throw new Error(label+" fields invalid")}
function record(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
