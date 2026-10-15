import { createHash } from "node:crypto";
import type { ImmutableBlobLocator, CandidateArtifactStore } from "./artifact-store.js";

export type SourcePackRole = "source_target_pack" | "source_head_pack";
export interface SourcePackRequestInput {
 readonly tenantId:string; readonly repositoryId:string; readonly operationId:string; readonly fenceToken:string;
 readonly providerRepositoryId:string; readonly ref:string; readonly expectedOid:string; readonly role:SourcePackRole;
 readonly remoteUrl:string; readonly username:string; readonly password:string; readonly opaqueProof?:string; readonly allowWrite:boolean;
}
export interface SourcePackPublic {
 readonly tenant_id:string; readonly repository_id:string; readonly operation_id:string; readonly fence_token:string;
 readonly provider_repository:string; readonly ref:string; readonly expected_oid:string; readonly role:SourcePackRole; readonly output_dir:string;
}
export interface SourcePackFrame {
 readonly public:SourcePackPublic; readonly requestSha256:string; readonly stdin:string; readonly argv:readonly string[];
}
export interface SourcePackResult {
 readonly packSha256:string; readonly packSizeBytes:number; readonly manifestSha256:string; readonly gitVersion:string;
}
export interface StoredSourcePack {
 readonly public:SourcePackPublic; readonly manifest:ImmutableBlobLocator; readonly pack:ImmutableBlobLocator;
}
const produceFrame="gitfoundry.source-pack.produce.v1", exportFrame="gitfoundry.source-pack.export.v1";
const helper="/usr/local/bin/gitfoundry-source-pack";
const successKeys=["frame","ok","status","tenant_id","repository_id","operation_id","fence_token","provider_repository","ref","expected_oid","tip","role","request_sha256","pack_sha256","pack_size_bytes","pack_filename","manifest_sha256","git_version","state_ref"];
const maxPackBytes=128*1024*1024;

export function buildSourcePackRequest(input:SourcePackRequestInput):SourcePackFrame {
 for(const value of [input.tenantId,input.repositoryId,input.operationId,input.fenceToken]) {
  if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)||value.includes("..")) throw new Error("source pack identity invalid");
 }
 if(input.allowWrite!==false) throw new Error("source pack requires read-only capability");
 if(!/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/u.test(input.providerRepositoryId)) throw new Error("source pack provider identity invalid");
 validateRef(input.ref); oid(input.expectedOid);
 if(input.role!=="source_target_pack"&&input.role!=="source_head_pack") throw new Error("source pack role invalid");
 const remote=new URL(input.remoteUrl);
 if(!["https:","http:"].includes(remote.protocol)||remote.username||remote.password||remote.search||remote.hash) throw new Error("source pack remote invalid");
 for(const [value,bound] of [[input.username,256],[input.password,2048]] as const) {
  if(typeof value!=="string"||value.length===0||/[\u0000\r\n]/u.test(value)||new TextEncoder().encode(value).length>bound) throw new Error("source pack credential bound invalid");
 }
 if(input.opaqueProof!==undefined&&!/^[A-Za-z0-9._~:-]{16,512}$/u.test(input.opaqueProof)) throw new Error("source pack proof invalid");
 if(remote.protocol==="https:"&&input.opaqueProof===undefined) throw new Error("source pack proof required");
 const publicInput:SourcePackPublic={
  tenant_id:input.tenantId,repository_id:input.repositoryId,operation_id:input.operationId,fence_token:input.fenceToken,
  provider_repository:input.providerRepositoryId,ref:input.ref,expected_oid:input.expectedOid,role:input.role,
  output_dir:`/work/${input.tenantId}/${input.repositoryId}/${input.operationId}/source-pack`
 };
 const privateInput={provider_url:input.remoteUrl,credential:{type:"basic",username:input.username,password:input.password},
  ...(input.opaqueProof===undefined?{}:{artifacts_egress_proof:input.opaqueProof})};
 const stdin=JSON.stringify({frame:produceFrame,public:publicInput,private:privateInput})+"\n";
 if(new TextEncoder().encode(stdin).length>8192) throw new Error("source pack private stdin bound exceeded");
 const requestSha256=digest(canonicalJson(publicInput));
 return {public:publicInput,requestSha256,stdin,argv:[helper,"produce","--request-format",produceFrame,"--request-sha256",requestSha256]};
}

export function parseSourcePackResult(stdout:string,expected:SourcePackFrame):SourcePackResult {
 const value=singleJson(stdout,32768);
 if(value.ok!==true||value.status!=="packed") throw new Error("source pack helper rejected source input");
 exactKeys(value,successKeys);
 const fields={frame:"gitfoundry.source-pack.result.v1",tenant_id:expected.public.tenant_id,repository_id:expected.public.repository_id,
  operation_id:expected.public.operation_id,fence_token:expected.public.fence_token,provider_repository:expected.public.provider_repository,
  ref:expected.public.ref,expected_oid:expected.public.expected_oid,tip:expected.public.expected_oid,role:expected.public.role,
  request_sha256:expected.requestSha256,pack_filename:"source.pack",state_ref:"source-pack/manifest.json",git_version:"2.39.5"};
 for(const [field,expectedValue] of Object.entries(fields)) if(value[field]!==expectedValue) throw new Error("source pack result identity mismatch: "+field);
 const packSha256=sha256(value.pack_sha256),manifestSha256=sha256(value.manifest_sha256);
 const packSizeBytes=value.pack_size_bytes;
 if(typeof packSizeBytes!=="number"||!Number.isSafeInteger(packSizeBytes)||packSizeBytes<32||packSizeBytes>maxPackBytes) throw new Error("source pack result size invalid");
 return {packSha256,packSizeBytes,manifestSha256,gitVersion:"2.39.5"};
}

export function validateSourcePackManifest(text:string,expected:SourcePackFrame,result:SourcePackResult):void {
 if(digest(text)!==result.manifestSha256) throw new Error("source manifest digest mismatch");
 const value=singleJson(text,65536);
 exactKeys(value,["frame","public","request_sha256","pack","git_version"]);
 if(value.frame!=="gitfoundry.source-pack.manifest.v1"||value.request_sha256!==expected.requestSha256||
    value.git_version!=="2.39.5"||canonicalJson(value.public)!==canonicalJson(expected.public)) throw new Error("source manifest identity mismatch");
 if(!record(value.pack)) throw new Error("source manifest pack invalid");
 exactKeys(value.pack,["filename","sha256","size_bytes"]);
 if(value.pack.filename!=="source.pack"||value.pack.sha256!==result.packSha256||value.pack.size_bytes!==result.packSizeBytes) throw new Error("source manifest pack mismatch");
}

export async function captureSourcePackArtifacts(container:Pick<Container,"exec">,cwd:string,env:Record<string,string>,frame:SourcePackFrame,result:SourcePackResult,store:Pick<CandidateArtifactStore,"putAppendOnly">):Promise<StoredSourcePack> {
 const manifestProcess=await exportProcess(container,cwd,env,frame,"manifest",result.manifestSha256);
 const [manifestText,manifestError,manifestExit]=await Promise.all([collectBoundedText(manifestProcess.stdout,65536),collectBoundedText(manifestProcess.stderr,32768),manifestProcess.exitCode]);
 if(manifestExit!==0) throw new Error("source manifest export failed: "+manifestError);
 validateSourcePackManifest(manifestText,frame,result);
 const manifestBytes=new TextEncoder().encode(manifestText);
 const scope={tenantId:frame.public.tenant_id,repositoryId:frame.public.repository_id,operationId:frame.public.operation_id,requestSha256:frame.requestSha256,expiresAt:null};
 const manifest=await store.putAppendOnly({...scope,kind:"source_manifest",body:byteStream(manifestBytes),expectedSha256:result.manifestSha256,expectedSizeBytes:manifestBytes.length,contentType:"application/json"});
 const packProcess=await exportProcess(container,cwd,env,frame,"pack",result.packSha256);
 if(!packProcess.stdout) throw new Error("source pack export stdout missing");
 const [pack,packError,packExit]=await Promise.all([
  store.putAppendOnly({...scope,kind:frame.public.role,body:packProcess.stdout,expectedSha256:result.packSha256,expectedSizeBytes:result.packSizeBytes,contentType:"application/octet-stream"}),
  collectBoundedText(packProcess.stderr,32768),packProcess.exitCode
 ]);
 if(packExit!==0) throw new Error("source pack export failed: "+packError);
 return {public:frame.public,manifest,pack};
}
async function exportProcess(container:Pick<Container,"exec">,cwd:string,env:Record<string,string>,frame:SourcePackFrame,artifact:"manifest"|"pack",expectedSha:string):Promise<ExecProcess> {
 const publicInput={tenant_id:frame.public.tenant_id,repository_id:frame.public.repository_id,operation_id:frame.public.operation_id,state_dir:frame.public.output_dir,artifact,expected_sha256:expectedSha};
 const requestSha=digest(canonicalJson(publicInput));
 const process=await container.exec([helper,"export","--request-format",exportFrame,"--request-sha256",requestSha],{cwd,env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 if(!process.stdin) throw new Error("source export stdin missing");
 const writer=process.stdin.getWriter();
 try {await writer.write(new TextEncoder().encode(JSON.stringify({frame:exportFrame,public:publicInput})+"\n"));await writer.close()} finally {writer.releaseLock()}
 return process;
}
export async function collectBoundedText(stream:ReadableStream<Uint8Array>|null,maxBytes:number):Promise<string> {
 if(!stream) throw new Error("helper output stream missing");
 const reader=stream.getReader();const chunks:Uint8Array[]=[];let bytes=0;let overflow=false;
 try {
  while(true) {const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes){overflow=true;continue}chunks.push(next.value)}
 } finally {reader.releaseLock()}
 if(overflow) throw new Error("helper output byte bound exceeded");
 const output=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length}
 return new TextDecoder("utf-8",{fatal:true}).decode(output);
}
export function canonicalJson(value:unknown):string {
 if(Array.isArray(value))return "["+value.map(canonicalJson).join(",")+"]";
 if(record(value))return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonicalJson(value[key])).join(",")+"}";
 const result=JSON.stringify(value);if(result===undefined)throw new Error("canonical source value invalid");return result;
}
export function byteStream(bytes:Uint8Array):ReadableStream<Uint8Array> {return new ReadableStream({start(c){c.enqueue(bytes);c.close()}})}
function digest(value:string):string {return createHash("sha256").update(value).digest("hex")}
function sha256(value:unknown):string {if(typeof value!=="string"||!/^[0-9a-f]{64}$/u.test(value))throw new Error("source digest invalid");return value}
function oid(value:string):void {if(typeof value!=="string"||!/^[0-9a-f]{40}$/u.test(value)||value==="0".repeat(40))throw new Error("source tip invalid")}
function validateRef(ref:string):void {
 if(typeof ref!=="string"||!ref.startsWith("refs/")||ref.includes("..")||ref.includes("@{")||/[\u0000-\u0020\u007f~^:?*\\[\]\\]/u.test(ref)||
 ref.split("/").some(part=>part.length===0||part.startsWith(".")||part.endsWith(".")||part.endsWith(".lock")))throw new Error("source ref invalid");
}
function singleJson(text:string,maxBytes:number):Record<string,unknown> {
 if(new TextEncoder().encode(text).length>maxBytes)throw new Error("source output bound exceeded");
 const lines=text.split("\n").filter(line=>line.trim().length>0);if(lines.length!==1)throw new Error("source output must be one JSON line");
 const value:unknown=JSON.parse(lines[0]!);if(!record(value))throw new Error("source output object required");return value;
}
function record(value:unknown):value is Record<string,unknown> {return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function exactKeys(value:Record<string,unknown>,keys:readonly string[]):void {if(Object.keys(value).sort().join("\0")!==[...keys].sort().join("\0"))throw new Error("source output fields invalid")}
