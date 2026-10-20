import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fault,isId} from './hapi-device-store.mjs';
const require=createRequire(import.meta.url);
const {Codex}=require('./codex.cjs');
const {Hapi,projectMessages}=require('./hapi.cjs');
export {projectMessages};
export class CodexDirectory {
  constructor(root){this.client=new Codex(root,()=>{});}
  async rpc(method,params){await this.client.connect();return this.client.rpc(method,params,['thread/list','thread/read','thread/turns/list'].includes(method)?60000:30000);}
  async list(projects){
    let cursor;const rows=[];const seen=new Set();
    let complete=false;
    for(let i=0;i<100;i++){
      const r=await this.rpc('thread/list',{limit:100,sortKey:'updated_at',sourceKinds:[],cwd:projects,archived:false,...(cursor?{cursor}:{})});
      if(!Array.isArray(r.data))throw fault('DIRECTORY_PROTOCOL',502);rows.push(...r.data);
      if(!r.nextCursor){complete=true;break;}if(seen.has(r.nextCursor))throw fault('DIRECTORY_CURSOR',502);seen.add(r.nextCursor);cursor=r.nextCursor;
    }
    if(!complete)throw fault('DIRECTORY_LIMIT',503);
    const unique=new Map(),duplicates=new Set();
    for(const row of rows){if(!isId(row.id))continue;if(unique.has(row.id))duplicates.add(row.id);else unique.set(row.id,row);}
    // Local history migrations can leave two list records for the same UUID.
    // Read the authoritative metadata instead of guessing by title/mtime/path.
    for(const id of duplicates){try{const thread=await this.metadata(id);if(thread?.id===id)unique.set(id,thread);else unique.delete(id);}catch{unique.delete(id);}}
    return [...unique.values()];
  }
  async read(id,cursor){
    const {thread}=await this.rpc('thread/read',{threadId:id,includeTurns:false});
    const turns=await this.rpc('thread/turns/list',{threadId:id,limit:50,itemsView:'full',sortDirection:'desc',...(cursor?{cursor}:{})});
    if(!thread||!Array.isArray(turns.data))throw fault('DIRECTORY_PROTOCOL',502);
    const messages=[];
    for(const turn of [...turns.data].reverse())for(const item of turn.items??[]){
      if(item.type==='userMessage'){
        const text=(item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
        // Exclude injected environment/instruction envelopes; do not expose tools/reasoning.
        if(text&&!/^\s*(# AGENTS\.md instructions|<environment_context>)/i.test(text))messages.push({id:item.id,role:'user',text});
      }else if(item.type==='agentMessage'&&typeof item.text==='string')messages.push({id:item.id,role:'agent',text:item.text});
    }
    return {thread,messages,nextCursor:turns.nextCursor??null,hasOlder:!!turns.nextCursor};
  }
  close(){this.client.close();}
  async metadata(id){return (await this.rpc('thread/read',{threadId:id,includeTurns:false})).thread;}
}
export class HapiOwner {
  constructor({root,url,token}){this.client=new Hapi(root);this.url=url;this.token=token;}
  async json(route,method='GET',body){if(!this.client.status().connected)await this.client.connect({url:this.url,token:this.token});return this.client.json(route,method,body);}
  close(){this.client.disconnect();}
}
const threadOf=s=>s.metadata?.codexThreadId||s.metadata?.codexSessionId;
export class ThreadDirectory {
  constructor({codex,hapi,machineId,executors}){Object.assign(this,{codex,hapi,machineId,executors});}
  async allowed(device,thread){
    if(!isId(thread?.id)||typeof thread.cwd!=='string'||device.grants.threadIds.length&&!device.grants.threadIds.includes(thread.id))return false;
    try{return device.grants.projects.includes(await fs.realpath(thread.cwd));}catch{return false;}
  }
  async sessions(){
    const {sessions}=await this.hapi.json('/api/sessions');if(!Array.isArray(sessions))throw fault('UPSTREAM_PROTOCOL',502);
    return sessions;
  }
  async mappings(threads){
    const ids=new Set(threads.map(t=>t.id)),paths=new Set(threads.map(t=>t.cwd));
    const rows=(await this.sessions()).filter(s=>s.metadata?.machineId===this.machineId&&paths.has(s.metadata?.path)&&ids.has(s.metadata?.agentSessionId||threadOf(s)));
    const result=new Map();
    for(const row of rows){
      const {session}=await this.hapi.json(`/api/sessions/${row.id}`);
      const id=threadOf(session),thread=threads.find(t=>t.id===id);
      // Source IDs describe forks/import provenance and are never used as identity.
      if(!thread||session.metadata?.machineId!==this.machineId||session.metadata?.path!==thread.cwd)continue;
      const group=result.get(id)??[];group.push(session);result.set(id,group);
    }return result;
  }
  card(thread,group=[]){
    const active=group.filter(s=>s.active);const candidates=active.length?active:group;
    const session=candidates.length===1?candidates[0]:null;
    const state=candidates.length>1?'mapping_conflict':session?.active?(Object.keys(session.agentState?.requests??{}).length?'waiting_permission':session.thinking?'working':'idle'):'resumable';
    return {id:thread.id,threadId:thread.id,sessionId:session?.id??null,machineId:this.machineId,project:thread.cwd,
      projectName:path.basename(thread.cwd),projectId:thread.projectId??null,label:thread.name||thread.preview?.slice(0,100)||thread.id,
      summary:String(thread.preview||'').slice(0,300),updatedAt:thread.updatedAt*1000,state,
      stateVerified:!!session?.active,desktopState:thread.status?.type??'unknown',source:typeof thread.source==='string'?thread.source:'subAgent',aliases:[],
      model:thread.model??null,mapping:session?'verified':candidates.length>1?'conflict':'unmapped'};
  }
  async list(device){
    const rows=await this.codex.list(device.grants.projects);const threads=[];
    for(const t of rows)if(await this.allowed(device,t))threads.push(t);
    const mapping=await this.mappings(threads);
    return threads.map(t=>this.card(t,mapping.get(t.id)));
  }
  async read(device,id,cursor){
    if(!isId(id)||device.grants.threadIds.length&&!device.grants.threadIds.includes(id))throw fault('ACCESS_DENIED',403);
    const metadata=await this.codex.metadata(id).catch(()=>{throw fault('ACCESS_DENIED',403);});
    if(!await this.allowed(device,metadata))throw fault('ACCESS_DENIED',403);
    const r=await this.codex.read(id,cursor);
    if(!await this.allowed(device,r.thread))throw fault('ACCESS_DENIED',403);
    const mappings=await this.mappings([r.thread]);return {...r,thread:undefined,target:this.card(r.thread,mappings.get(id)),completionVerified:false};
  }
  async resolveSession(device,id){
    if(!isId(id))throw fault('ACCESS_DENIED',403);
    const {session}=await this.hapi.json(`/api/sessions/${id}`);
    const threadId=threadOf(session);
    if(session?.metadata?.machineId!==this.machineId||!isId(threadId))throw fault('ACCESS_DENIED',403);
    const result=await this.read(device,threadId);
    if(result.target.sessionId!==id||session.metadata.path!==result.target.project)throw fault('ACCESS_DENIED',403);
    return {session,target:result.target};
  }
  async create(device,{project}){
    if(device.grants.threadIds.length||typeof project!=='string')throw fault('ACCESS_DENIED',403);
    let canonical;try{canonical=await fs.realpath(project);}catch{throw fault('ACCESS_DENIED',403);}
    if(!device.grants.projects.includes(canonical)||canonical!==project)throw fault('ACCESS_DENIED',403);
    const result=await this.hapi.json(`/api/machines/${this.machineId}/spawn`,'POST',{directory:canonical,agent:'codex',permissionMode:'read-only',sessionType:'simple',startingMode:'remote'});
    if(result.type!=='success'||!isId(result.sessionId))throw fault('CREATE_THREAD_UNCONFIRMED',502);
    const end=Date.now()+60000;
    do{const {session}=await this.hapi.json(`/api/sessions/${result.sessionId}`);const id=threadOf(session);
      if(session.metadata?.machineId!==this.machineId||session.metadata?.path!==canonical)throw fault('THREAD_IDENTITY_MISMATCH',409);
      if(isId(id))return{sessionId:session.id,target:{id,threadId:id,sessionId:session.id,machineId:this.machineId,project:canonical,label:session.metadata.name||'新聊天',state:session.active?'idle':'resumable'}};
      await new Promise(r=>setTimeout(r,300));
    }while(Date.now()<end);throw fault('CREATE_THREAD_UNCONFIRMED',502);
  }
  async open(device,id,{allowBusy=false}={}){
    const {target}=await this.read(device,id);
    if(target.state==='mapping_conflict'||!allowBusy&&['working','waiting_permission'].includes(target.state))throw fault('TARGET_NOT_READY',409);
    let sessionId=target.sessionId;
    if(!sessionId){
      const imported=await this.hapi.json('/api/codex/sync-session','POST',{sessionIds:[id],machineId:this.machineId,cwd:target.project,yolo:false,...(target.model?{model:target.model}:{})});
      if(imported.success!==true||imported.hapiSessionIds?.length!==1)throw fault('IMPORT_FAILED',502);
      sessionId=imported.hapiSessionIds[0];
    }
    let {session}=await this.hapi.json(`/api/sessions/${sessionId}`);
    const check=s=>s?.metadata?.machineId===this.machineId&&s.metadata.path===target.project&&threadOf(s)===id;
    if(!check(session))throw fault('THREAD_IDENTITY_MISMATCH',409);
    if(!session.active&&this.executors){
      const reattached=await this.executors.recover(session);
      if(reattached)({session}=await this.hapi.json(`/api/sessions/${sessionId}`));
    }
    if(!session.active){
      const resumed=await this.hapi.json(`/api/sessions/${sessionId}/resume`,'POST',{permissionMode:'read-only'});
      if(resumed.type!=='success'||!isId(resumed.sessionId))throw fault('RESUME_FAILED',502);
      sessionId=resumed.sessionId;
      ({session}=await this.hapi.json(`/api/sessions/${sessionId}`));
      if(!check(session))throw fault('THREAD_IDENTITY_MISMATCH',409);
    }
    return {session,target:{...target,sessionId}};
  }
}
