import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const packageJson = process.env.GFY_WRANGLER_PACKAGE_JSON;
const require = packageJson ? createRequire(packageJson) : createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const source = `
import {CandidateArtifactStore} from "./apps/api-worker/src/merge-candidate/artifact-store.ts";
export default {async fetch(request,env) {
 const value=await request.json();
 const store=new CandidateArtifactStore(env.BLOBS,env.DB);
 try {
  if(value.action==="get") {
   const body=await store.getVerified(value.locator);
   return new Response(body);
  }
  const bytes=new Uint8Array(value.bytes);
  const body=new ReadableStream({start(c){c.enqueue(bytes.slice(0,3));c.enqueue(bytes.slice(3));c.close()}});
  const locator=await store.putAppendOnly({...value.input,body});
  return Response.json({locator});
 } catch(error) {return Response.json({error:String(error)}, {status:409})}
}};
`;
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:"artifact-r2-gate.ts",loader:"ts"},bundle:true,write:false,format:"esm",platform:"neutral",external:["node:crypto"],logLevel:"error"});
const options={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-10-07",compatibilityFlags:["nodejs_compat"],r2Buckets:["BLOBS"],d1Databases:["DB"]};
const mf=new Miniflare(typeof convertV4MiniflareOptions==="function"?convertV4MiniflareOptions(options):options);
const bytes=new Uint8Array([0,1,2,255,254,0,72,73]);
const sha=body=>createHash("sha256").update(body).digest("hex");
const input={tenantId:"tenant-a",repositoryId:"repo-a",operationId:"op-a",requestSha256:"a".repeat(64),kind:"candidate_pack",expectedSha256:sha(bytes),expectedSizeBytes:bytes.length,contentType:"application/octet-stream",expiresAt:null};
const request=async(value)=>mf.dispatchFetch("https://artifact.test/",{method:"POST",body:JSON.stringify(value),headers:{"content-type":"application/json"}});
try {
 const db=await mf.getD1Database("DB"); const bucket=await mf.getR2Bucket("BLOBS");
 const schema=await readFile(resolve(root,"docs/source/handoff/contracts/schema.sql"),"utf8");
 const table=schema.match(/CREATE TABLE artifacts \([\s\S]*?\n\);/)[0];
 await db.exec("CREATE TABLE tenants(id TEXT PRIMARY KEY); CREATE TABLE repositories(tenant_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(tenant_id,id)); CREATE TABLE runs(tenant_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(tenant_id,id));");
 await db.exec(table.replaceAll("\n"," "));
 await db.prepare("INSERT INTO tenants(id) VALUES (?)").bind(input.tenantId).run();
 await db.prepare("INSERT INTO repositories(tenant_id,id) VALUES (?,?)").bind(input.tenantId,input.repositoryId).run();
 const [a,b]=await Promise.all([request({input,bytes:[...bytes]}),request({input,bytes:[...bytes]})]);
 assert.equal(a.status,200,await a.clone().text()); assert.equal(b.status,200,await b.clone().text());
 const locator=(await a.json()).locator; assert.deepEqual((await b.json()).locator,locator);
 const row=await db.prepare("SELECT * FROM artifacts").first(); assert.equal(row.digest,sha(bytes)); assert.equal(row.size_bytes,bytes.length);
 const count=await db.prepare("SELECT COUNT(*) AS count FROM artifacts").first();assert.equal(count.count,1);
 const get=await request({action:"get",locator});assert.equal(get.status,200);assert.deepEqual(new Uint8Array(await get.arrayBuffer()),bytes);
 const object=await bucket.get(locator.key); assert.equal(object.size,bytes.length);assert.equal(Buffer.from(object.checksums.sha256).toString("hex"),sha(bytes));
 const changed=bytes.map(b=>b^1);
 const collision=await request({input:{...input,expectedSha256:sha(changed)},bytes:[...changed]});assert.equal(collision.status,409);assert.match(await collision.text(),/digest/);
 assert.deepEqual(new Uint8Array(await (await bucket.get(locator.key)).arrayBuffer()),bytes);
 for(const body of [bytes.slice(0,-1),new Uint8Array([...bytes,9]),changed]) {
  const op="bad-"+body.length+"-"+sha(body).slice(0,8);
  const response=await request({input:{...input,operationId:op},bytes:[...body]});
  assert.equal(response.status,409);assert.match(await response.text(),/size|digest|checksum|stream/i);
  const list=await bucket.list({prefix:"v1/tenants/tenant-a/repositories/repo-a/merge-operations/"+op+"/"});assert.equal(list.objects.length,0);
 }
 const finalCount=await db.prepare("SELECT COUNT(*) AS count FROM artifacts").first();assert.equal(finalCount.count,1);
 console.log("candidate-artifact R2 conditional-write, checksum, binary-read and D1 replay gates passed");
} finally {await mf.dispose()}
