// Recover the original runtime; recycle only a verified exclusive idle runtime, without submitting a turn.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import WebSocket from 'ws';
const fault=code=>new Error(code);
export function processMarker(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return null;
 try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C',TZ:'UTC'},stdio:['ignore','pipe','ignore']}).trim()||null;}catch{return null;}
}
export class RetainedExecutors {
 constructor({home,url,token,executable,owner,marker=processMarker,now=Date.now}){Object.assign(this,{home,url,executable,owner,marker,now});this.authHash=createHash('sha256').update(token).digest('hex');this.inflight=new Map();}
 async records(){
  const dir=path.join(this.home,'codex-runtimes'),out=[];
  for(const f of await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return[];throw e;})){
   if(!/^[a-zA-Z0-9-]+\.json$/.test(f))continue;
   const file=path.join(dir,f),st=await fs.lstat(file);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o022))continue;
   let r;try{r=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
   if(r.hub!==this.url||r.authHash!==this.authHash||!r.sessions||!r.marker||this.marker(r.pid)!==r.marker)continue;
   let command;try{command=execFileSync('/bin/ps',['-p',String(r.pid),'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{continue;}
   if(!command.startsWith(this.executable+' codex '))continue;
   out.push(r);
  }return out;
 }
 async socket(r){
  if(typeof r.endpoint!=='string'||!r.endpoint.startsWith('unix://'))throw fault('EXECUTOR_ENDPOINT_INVALID');
  const file=r.endpoint.slice(7),dir=path.dirname(file);
  if(path.basename(file)!=='clients.sock'||!/^hapi-cx-[A-Za-z0-9]+$/.test(path.basename(dir)))throw fault('EXECUTOR_ENDPOINT_INVALID');
  const [parent,socket]=await Promise.all([fs.lstat(dir),fs.lstat(file)]);
  if(!parent.isDirectory()||parent.uid!==process.getuid()||(parent.mode&0o077)||!socket.isSocket()||socket.uid!==process.getuid())throw fault('EXECUTOR_ENDPOINT_INVALID');
  return file;
 }
 async probe(r,session,{inspectIdle=false}={}){
  const binding=r.sessions[session.id],id=session.metadata?.codexThreadId||session.metadata?.codexSessionId;
  if(!binding?.active||binding.threadId!==id||session.namespace&&binding.namespace!==session.namespace)throw fault('EXECUTOR_IDENTITY_MISMATCH');
  const socket=await this.socket(r);
  // Bind one local connection to a verified PID generation and the protected Unix socket.
  if(this.marker(r.pid)!==r.marker)throw fault('EXECUTOR_GENERATION_CHANGED');
  const ws=new WebSocket(`ws+unix://${socket}:/`,{handshakeTimeout:4000,maxPayload:2*1024*1024,perMessageDeflate:false});
  const pending=new Map();let closed=false;
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(fault('EXECUTOR_RPC_TIMEOUT'));},6000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString());}catch{return;}
   if(m.method&&m.id!==undefined){ws.send(JSON.stringify({id:m.id,error:{code:-32601,message:'Connection recovery does not approve actions'}}));return;}
   const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(fault('EXECUTOR_RPC_REJECTED')):p.resolve(m.result);
  });
  const close=()=>{if(closed)return;closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(fault('EXECUTOR_DISCONNECTED'));}pending.clear();};ws.on('close',close);ws.on('error',close);
  try{
   await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(fault('EXECUTOR_UNREACHABLE')));});
   await request('initialize',{clientInfo:{name:'moecast_connection_recovery',version:'0.2.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized'}));
   const attached=await request('hapi/attach',{sessionId:session.id});if(attached?.threadId!==id)throw fault('EXECUTOR_IDENTITY_MISMATCH');
   // A read confirms the actual original thread/cwd without resuming or changing it.
   const read=await request('thread/read',{threadId:id,includeTurns:false});
   if(read?.thread?.id!==id||read.thread.cwd!==session.metadata.path||this.marker(r.pid)!==r.marker)throw fault('EXECUTOR_IDENTITY_MISMATCH');
   const result={sessionId:session.id,threadId:id,pid:r.pid,serverPid:r.serverPid,status:read.thread.status?.type??'unknown'};
   if(inspectIdle){
    const turns=await request('thread/turns/list',{threadId:id,limit:1,itemsView:'full',sortDirection:'desc'});
    const queue=await request('thread/queue/list',{threadId:id});
    result.idleSnapshot={threadStatus:result.status,turnStatuses:Array.isArray(turns?.data)?turns.data.map(t=>t.status):null,queueCount:Array.isArray(queue?.data)?queue.data.length:null,queueHasMore:!!queue?.nextCursor};
   }
   return result;
  }finally{ws.close();close();}
 }
 async recover(session,{timeoutMs=6000}={}){
  if(session.active)return null;
  if(this.inflight.has(session.id))return this.inflight.get(session.id);
  const action=this.recoverNow(session,timeoutMs).finally(()=>this.inflight.delete(session.id));this.inflight.set(session.id,action);return action;
 }
 async recoverNow(session,timeoutMs){
  const records=(await this.records()).filter(r=>r.sessions[session.id]?.active);
  if(!records.length)return null;if(records.length!==1)throw fault('EXECUTOR_MAPPING_CONFLICT');
  const r=records[0],attached=await this.probe(r,session),deadline=this.now()+timeoutMs;
  do{
   const {session:current}=await this.owner.json(`/api/sessions/${session.id}`);
   const id=current.metadata?.codexThreadId||current.metadata?.codexSessionId;
   if(id!==attached.threadId||current.metadata?.machineId!==session.metadata.machineId||current.metadata?.path!==session.metadata.path)throw fault('EXECUTOR_IDENTITY_MISMATCH');
   if(this.marker(r.pid)!==r.marker)throw fault('EXECUTOR_GENERATION_CHANGED');
   if(current.active)return {...attached,recovered:true};
   await new Promise(resolve=>setTimeout(resolve,300));
  }while(this.now()<deadline);
  return this.recycleIdle(r,session);
 }
 async recycleIdle(r,session){
  if(Object.values(r.sessions).filter(s=>s.active).length!==1||r.pendingCreations?.length)throw fault('EXECUTOR_SHARED_OR_UNCONFIRMED');
  const inspected=await this.probe(r,session,{inspectIdle:true});
  let ledger={};try{ledger=JSON.parse(await fs.readFile(path.join(this.home,'codex-runtimes/queues',session.id+'.queue.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw fault('EXECUTOR_QUEUE_UNVERIFIED');}
  if(!idleRecoveryAllowed(inspected.idleSnapshot,ledger)||Object.keys(session.agentState?.requests??{}).length)throw fault('EXECUTOR_BUSY_KEEP_RUNNING');
  if(this.marker(r.pid)!==r.marker||r.serverPid&&this.marker(r.serverPid)!==r.serverMarker)throw fault('EXECUTOR_GENERATION_CHANGED');
  // A verified single-thread, idle runtime can shut down normally; never SIGKILL or delete locks.
  process.kill(r.pid,'SIGTERM');const end=this.now()+12000;
  while(this.now()<end&&(this.marker(r.pid)===r.marker||r.serverPid&&this.marker(r.serverPid)===r.serverMarker))await new Promise(resolve=>setTimeout(resolve,200));
  if(this.marker(r.pid)===r.marker||r.serverPid&&this.marker(r.serverPid)===r.serverMarker)throw fault('EXECUTOR_STOP_UNCONFIRMED');
  // Hub liveness can outlast a dead process. Wait for it to become inactive;
  // otherwise upstream resume may report success without spawning an executor.
  const inactiveEnd=this.now()+30000;let inactive=false,inactiveSince=0;
  do{const {session:state}=await this.owner.json(`/api/sessions/${session.id}`);if(!state.active){inactiveSince||=this.now();if(this.now()-inactiveSince>=2000){inactive=true;break;}}else inactiveSince=0;await new Promise(resolve=>setTimeout(resolve,300));}while(this.now()<inactiveEnd);
  if(!inactive)throw fault('EXECUTOR_HUB_STATE_UNCONFIRMED');
  const mode=session.permissionMode;
  const resumed=await this.owner.json(`/api/sessions/${session.id}/resume`,'POST',typeof mode==='string'?{permissionMode:mode}:{});
  if(resumed.type!=='success'||resumed.sessionId!==session.id)throw fault('EXECUTOR_RESUME_UNCONFIRMED');
  const {session:current}=await this.owner.json(`/api/sessions/${session.id}`);
  if((current.metadata?.codexThreadId||current.metadata?.codexSessionId)!==inspected.threadId||current.metadata?.path!==session.metadata.path||current.metadata?.machineId!==session.metadata.machineId||!current.active)throw fault('EXECUTOR_IDENTITY_MISMATCH');
  const running=(await this.records()).find(candidate=>candidate.pid!==r.pid&&candidate.sessions[session.id]?.active);
  if(!running)throw fault('EXECUTOR_RESUME_UNCONFIRMED');
  const verified=await this.probe(running,current);
  return {sessionId:session.id,threadId:inspected.threadId,recovered:true,mode:'idle-runtime-restored',previousPid:r.pid,pid:verified.pid,serverPid:verified.serverPid};
 }
 async recoverAll(){
  const {sessions}=await this.owner.json('/api/sessions');const recovered=[],unresolved=[];
  const ids=new Set((await this.records()).flatMap(r=>Object.keys(r.sessions).filter(id=>r.sessions[id].active)));
  await Promise.all((sessions??[]).filter(s=>!s.active&&ids.has(s.id)).map(async row=>{try{const {session}=await this.owner.json(`/api/sessions/${row.id}`);const result=await this.recover(session,{timeoutMs:6000});if(result)recovered.push(result);}catch(e){unresolved.push({sessionId:row.id,error:/^[A-Z_]+$/.test(e.message)?e.message:'EXECUTOR_RECOVERY_FAILED'});}}));
  return {recovered,unresolved};
 }
}

export function idleRecoveryAllowed(snapshot,ledger){
 return snapshot?.threadStatus==='idle'&&Array.isArray(snapshot.turnStatuses)&&snapshot.turnStatuses.every(s=>['completed','interrupted','failed'].includes(s))&&snapshot.queueCount===0&&!snapshot.queueHasMore&&ledger&&typeof ledger==='object'&&!Array.isArray(ledger)&&Object.values(ledger).every(e=>e&&['consumed','canceled','rejected'].includes(e.state));
}
