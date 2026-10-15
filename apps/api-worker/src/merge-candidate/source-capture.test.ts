import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers",()=>({DurableObject:class {constructor(readonly ctx:unknown,readonly env:unknown){}}}));
import { executeTrustedGitHelperOperation } from "../linux/execution.js";
import { buildSourcePackRequest } from "./source-packs.js";
const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const image="registry.example/gitfoundry-helper@sha256:"+"a".repeat(64);
const pack=new TextEncoder().encode("PACK fixture actual captured bytes for lifecycle tests");
const secret="private-source-token",proof="proof_0123456789abcdef",username="private-source-user";
const request=()=>({commandId:"source-a",tenantId:"tenant-a",repositoryId:"repo-a",operationId:"op-a",fenceToken:"fence-a",deadlineMs:30000,cwd:"/work/tenant-a/repo-a/op-a/subdir",providerId:"cloudflare-artifacts",providerRepositoryId:"tenant-a/repo-a",
 operation:{kind:"produce_source_pack",remoteUrl:"https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git",ref:"refs/heads/main",expectedOid:"1".repeat(40),role:"source_target_pack"},
 credential:{tenantId:"tenant-a",repositoryId:"repo-a",providerId:"cloudflare-artifacts",providerRepositoryId:"tenant-a/repo-a",username,password:secret,expiresAtMs:Date.now()+60000},
 artifactsEgress:{allowedProviderHostname:"gitfoundry-artifacts.internal",namespace:"tenant-a",repository:"repo-a",artifactsRemoteUrl:"https://gitfoundry-artifacts.internal/artifacts/tenant-a/repo-a.git",opaqueProof:proof,allowWrite:false}
});
function payloads() {
 const frame=buildSourcePackRequest({tenantId:"tenant-a",repositoryId:"repo-a",operationId:"op-a",fenceToken:"fence-a",providerRepositoryId:"tenant-a/repo-a",ref:"refs/heads/main",expectedOid:"1".repeat(40),role:"source_target_pack",remoteUrl:request().operation.remoteUrl,username,password:secret,opaqueProof:proof,allowWrite:false});
 const manifest=JSON.stringify({frame:"gitfoundry.source-pack.manifest.v1",public:frame.public,request_sha256:frame.requestSha256,pack:{filename:"source.pack",sha256:digest(pack),size_bytes:pack.length},git_version:"2.39.5"})+"\n";
 const result=JSON.stringify({frame:"gitfoundry.source-pack.result.v1",ok:true,status:"packed",tenant_id:"tenant-a",repository_id:"repo-a",operation_id:"op-a",fence_token:"fence-a",provider_repository:"tenant-a/repo-a",ref:"refs/heads/main",expected_oid:"1".repeat(40),tip:"1".repeat(40),role:"source_target_pack",request_sha256:frame.requestSha256,pack_sha256:digest(pack),pack_size_bytes:pack.length,pack_filename:"source.pack",manifest_sha256:digest(manifest),git_version:"2.39.5",state_ref:"source-pack/manifest.json"})+"\n";
 return {manifest,result};
}
class Storage {
 map=new Map<string,unknown>();alarmAt:number|undefined;
 async get<T>(key:string){return this.map.get(key) as T|undefined} async put(key:string,value:unknown){this.map.set(key,value)}
 async delete(key:string){return this.map.delete(key)} async setAlarm(at:number){this.alarmAt=at}async deleteAlarm(){this.alarmAt=undefined}
}
class Bucket {
 entries=new Map<string,{bytes:Uint8Array;customMetadata:Record<string,string>}>();
 async put(key:string,body:ReadableStream<Uint8Array>,options:R2PutOptions) {
  expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*");
  const bytes=new Uint8Array(await new Response(body).arrayBuffer());
  if(this.entries.has(key))return null;
  const customMetadata=options.customMetadata!;this.entries.set(key,{bytes,customMetadata});
  return {key,size:bytes.length,etag:digest(bytes),version:"version-1",customMetadata,checksums:{sha256:Uint8Array.from(Buffer.from(digest(bytes),"hex")).buffer}};
 }
}
class Database {
 rows=new Map<string,Record<string,unknown>>();
 prepare(_sql:string){const db=this;return {bind(...v:unknown[]){return {
  async run(){db.rows.set(String(v[0])+":"+String(v[1]),{tenant_id:v[0],id:v[1],repository_id:v[4],name:v[5],r2_key:v[6],digest:v[7],size_bytes:v[8],expires_at:v[9]});return {success:true}},
  async first(){return db.rows.get(String(v[0])+":"+String(v[1]))}
 }}}}
}
class CaptureContainer {
 images:Record<string,string>={gfy:"registry.example/gitfoundry-helper@sha256:"+"a".repeat(64)};
 lastStart:ContainerStartupOptions|undefined;
 running=false;labels:Record<string,string>={};calls:string[][]=[];inputs:string[]=[];destroyed=0;
 constructor(readonly bucket:Bucket,readonly db:Database,readonly corrupt:boolean){}
 async inspect(){return this.running?{image:this.lastStart?.image??"",labels:this.labels}:null}
 start(options:ContainerStartupOptions){this.lastStart=options;this.running=true;this.labels=options.labels??{}}
 async interceptOutboundHttp(){} async interceptOutboundHttps(){}
 async exec(argv:string[]){this.calls.push(argv);const p=payloads();let body:Uint8Array;
  if(argv[1]==="produce")body=new TextEncoder().encode(p.result);
  else if(argv[1]==="export"){
   body=argv.length&&this.calls.length===3?new TextEncoder().encode(p.manifest):this.corrupt?pack.map(b=>b^1):pack;
  } else body=new TextEncoder().encode("2.39.5\n");
  return {stdin:new WritableStream({write:(bytes:Uint8Array)=>{this.inputs.push(new TextDecoder().decode(bytes))}}),stdout:new ReadableStream({start(c){c.enqueue(body);c.close()}}),stderr:new ReadableStream({start(c){c.close()}}),exitCode:Promise.resolve(0)};
 }
 async destroy(){expect(this.bucket.entries.size).toBe(this.corrupt?1:2);expect(this.db.rows.size).toBe(this.corrupt?1:2);this.running=false;this.destroyed++}
}
describe("source-pack capture lifecycle (platform fixture)",()=>{
 for(const corrupt of [false,true])it(corrupt?"fails and cleans up a corrupt pack without a successful source receipt":"captures verified manifests and packs before cleanup and replays without provider reads",async()=>{
  vi.stubGlobal("FixedLengthStream",class extends TransformStream<Uint8Array,Uint8Array>{constructor(_length:number){super()}});
  try {
   const bucket=new Bucket(),db=new Database(),storage=new Storage(),container=new CaptureContainer(bucket,db,corrupt);
   const ctx={storage,container,exports:{GitFoundryArtifactsEgress:(init:unknown)=>init}} as unknown as DurableObjectState;
   const env={GFY_TRUSTED_GIT_HELPER_IMAGE:image,GFY_ARTIFACTS:bucket as unknown as R2Bucket,GFY_DB:db as unknown as D1Database};
   const response=await executeTrustedGitHelperOperation(ctx,env,request());
   const result=await response.json() as {receipt:{status:string;sourcePack?:{pack:{key:string;sha256:string};manifest:{key:string}}};replayed?:boolean};
   expect(response.status).toBe(corrupt?500:200);expect(result.receipt.status).toBe(corrupt?"failed":"succeeded");
   expect(container.destroyed).toBe(1);
   const retained=JSON.stringify([...storage.map.values()])+JSON.stringify([...db.rows.values()]);
   expect(retained).not.toContain(secret);expect(retained).not.toContain(proof);expect(retained).not.toContain(username);
   expect(JSON.stringify(container.calls)).not.toContain(secret);expect(container.inputs.join("")).toContain(secret);
   if(corrupt){expect(result.receipt.sourcePack).toBeUndefined()}
   else {
    const source=result.receipt.sourcePack!;expect(source.pack.sha256).toBe(digest(pack));
    expect(bucket.entries.get(source.pack.key)!.bytes).toEqual(pack);
    const calls=container.calls.length;
    const replay=await executeTrustedGitHelperOperation(ctx,env,request());
    expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,receipt:{sourcePack:source}});
    expect(container.calls.length).toBe(calls);
   }
  } finally {vi.unstubAllGlobals()}
 });
});
