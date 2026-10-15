import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const proofPath = process.argv[2];
const forkName = process.argv[3];
if (!proofPath || !/^[a-z0-9-]{1,63}$/.test(forkName ?? '')) throw new Error('Usage: node scripts/qualify-artifacts-git.mjs PRIVATE_PROOF_FILE UNIQUE_FORK_NAME');
if ((fs.statSync(proofPath).mode & 0o777) !== 0o600) throw new Error('proof credential file must be mode 0600');
const proof=JSON.parse(fs.readFileSync(proofPath,'utf8'));
const secrets=[proof.token];
const env={...process.env,HOME:process.env.GFY_PROVIDER_HOME ?? process.env.HOME,CLOUDFLARE_ACCOUNT_ID:new URL(proof.remote).hostname.split('.')[0],GIT_TERMINAL_PROMPT:'0',GIT_TRACE:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'GitFoundry Provider Proof',GIT_AUTHOR_EMAIL:'proof@gitfoundry.dev',GIT_COMMITTER_NAME:'GitFoundry Provider Proof',GIT_COMMITTER_EMAIL:'proof@gitfoundry.dev'};for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL'])delete env[k];
const redact=s=>secrets.reduce((x,k)=>x.split(k).join('[REDACTED]'),s);

function run(bin,args,opts={}){const r=spawnSync(bin,args,{env,encoding:'utf8',timeout:60000,...opts});if(r.error)throw r.error;return r}function ok(r,stage){if(r.status!==0)throw Error(stage+': '+redact(r.stderr||r.stdout).slice(-1000));return r.stdout.trim()}function cf(args){const r=run('cf',args);
const x=JSON.parse(ok(r,'cf'));return x.result??x}const root=path.resolve('.gfy-artifacts-proof');fs.mkdirSync(root,{recursive:true});
const bare=path.join(root,'canonical.git');
ok(run('git',['init','--bare',bare]),'git-init');
const auth=token=>({...env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+token});
const git=(args,opts={})=>run('git',['--git-dir',bare,...args],opts);

function commit(text,parent){const blob=ok(git(['hash-object','-w','--stdin'],{input:text+'\n'}),'blob');
const tree=ok(git(['mktree'],{input:'100644 blob '+blob+'\tproof.txt\n'}),'tree');return ok(git(['commit-tree',tree,...(parent?['-p',parent]:[])],{input:text+'\n'}),'commit')}const H=commit('base'),A=commit('agent-a',H),B=commit('agent-b',H);

function push(remote,token,commit,ref,expected){return git(['push','--porcelain','--force-with-lease='+ref+':'+expected,remote,commit+':'+ref],{env:auth(token)})}const ref='refs/heads/forge-head';
ok(push(proof.remote,proof.token,H,ref,''),'initialize-head');
ok(push(proof.remote,proof.token,A,'refs/heads/attempts/a',''),'retain-a');
ok(push(proof.remote,proof.token,B,'refs/heads/attempts/b',''),'retain-b');
ok(push(proof.remote,proof.token,A,ref,H),'first-conditional-update');
const stale=push(proof.remote,proof.token,B,ref,H);if(stale.status===0||!/stale info|fetch first|rejected/i.test(stale.stdout+stale.stderr))throw Error('stale update was not explicitly rejected');
const head=ok(git(['ls-remote',proof.remote,ref],{env:auth(proof.token)}),'read-head').split(/\s/)[0];if(head!==A)throw Error('stale update changed head');
console.log(JSON.stringify({stage:'stale-write-proof',expected:H,accepted:A,rejected:B,actual:head,passed:true}));
const read=cf(['artifacts','namespaces','tokens','create','core','--repo',proof.name,'--scope','read']);if(!read.plaintext)throw Error('read token missing; keys='+Object.keys(read));secrets.push(read.plaintext);
const denied=push(proof.remote,read.plaintext,B,'refs/heads/read-only-bypass','');if(denied.status===0||!/403|401|denied|forbidden|authentication|unauthorized/i.test(denied.stdout+denied.stderr))throw Error('read credential push was not explicitly denied');
console.log(JSON.stringify({stage:'read-only-write-denied',passed:true}));
// cf 1.0.0-beta13 overwrites the destination name with the source path name.
// Use the documented REST request for this control-plane operation only.
const providerTokenPath = process.env.GFY_PROVIDER_API_TOKEN_FILE;
if (!providerTokenPath || (fs.statSync(providerTokenPath).mode & 0o777) !== 0o600) throw new Error('private provider API token file is required for the cf fork-name collision workaround');
const providerToken = fs.readFileSync(providerTokenPath, 'utf8').trim();
if (!providerToken) throw new Error('provider API token must be nonempty');
secrets.push(providerToken);
const forkResponse = await fetch('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID) + '/artifacts/namespaces/' + encodeURIComponent(proof.namespace) + '/repos/' + encodeURIComponent(proof.name) + '/fork', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + providerToken, 'content-type': 'application/json' },
  body: JSON.stringify({ name: forkName })
});
const forkPayload = await forkResponse.json();
if (!forkResponse.ok || forkPayload.success !== true) throw new Error('Artifacts fork failed: ' + forkResponse.status + ' ' + redact(JSON.stringify(forkPayload.errors ?? [])));
const fork = forkPayload.result;if(!fork.remote||!fork.token)throw Error('fork credential missing; keys='+Object.keys(fork));secrets.push(fork.token);
const D=commit('agent-fork-result',A);
ok(push(fork.remote,fork.token,D,ref,A),'agent-fork-push');
const bypass=push(proof.remote,fork.token,D,'refs/heads/agent-bypass','');if(bypass.status===0||!/403|401|denied|forbidden|authentication|unauthorized|not found/i.test(bypass.stdout+bypass.stderr))throw Error('fork credential canonical write was not explicitly denied');
console.log(JSON.stringify({stage:'agent-fork-isolation',agent_commit:D,canonical_write_denied:true,passed:true}));
ok(git(['fetch',fork.remote,ref],{env:auth(fork.token)}),'trusted-import');
ok(push(proof.remote,proof.token,D,'refs/heads/attempts/imported-agent',''),'retain-import');
const mirror=path.join(root,'mirror.git');
ok(run('git',['clone','--mirror',proof.remote,mirror],{env:auth(read.plaintext)}),'mirror');for(const c of [H,A,B,D])if(ok(run('git',['--git-dir',mirror,'cat-file','-t',c]),'mirror-object')!=='commit')throw Error('mirror missing commit');
const refs=ok(run('git',['--git-dir',mirror,'for-each-ref','--format=%(refname)']),'mirror-refs').split('\n');for(const r of [ref,'refs/heads/attempts/a','refs/heads/attempts/b','refs/heads/attempts/imported-agent'])if(!refs.includes(r))throw Error('mirror missing retained ref '+r);fs.writeFileSync(proofPath,JSON.stringify({...proof,read_token:read.plaintext,agent_fork:fork,proof:{H,A,B,D,refs,verified_at:new Date().toISOString()}}),{mode:0o600});fs.chmodSync(proofPath,0o600);
console.log(JSON.stringify({stage:'artifacts-proof-complete',retained_commits:[H,A,B,D],retained_refs:refs,stale_write_rejected:true,read_only_write_denied:true,agent_isolated:true,mirror_complete:true}));
