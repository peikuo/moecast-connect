import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fault,isId} from './hapi-device-store.mjs';
import {explicitArtifactLinks} from './hapi-artifacts.mjs';
const require=createRequire(import.meta.url);
const {Codex}=require('./codex.cjs');
const {projectMessages}=require('./hapi.cjs');
export {projectMessages};
export class CodexDirectory {
  constructor(root){this.client=new Codex(root,()=>{});this.reads=new Map();}
  async rpc(method,params){
    const readonly=['thread/list','thread/read','thread/turns/list'].includes(method),key=JSON.stringify([method,params]);
    if(readonly&&this.reads.has(key))return this.reads.get(key);
    const task=(async()=>{
      let child;
      try{await this.client.connect();child=this.client.child;return await this.client.rpc(method,params,readonly?60000:30000);}
      catch(e){
        if(readonly&&['CODEX_TIMEOUT','CODEX_EXITED','CODEX_START_FAILED'].includes(e.message)){
          if(child&&this.client.child===child)this.client.close('CODEX_TIMEOUT');
          throw fault('DIRECTORY_TEMPORARY_UNAVAILABLE',503);
        }
        throw e;
      }
    })();
    if(readonly){this.reads.set(key,task);task.finally(()=>{if(this.reads.get(key)===task)this.reads.delete(key);}).catch(()=>{});}
    return task;
  }
  async list(){
    let cursor;const rows=[];const seen=new Set();
    let complete=false;
    for(let i=0;i<100;i++){
      const r=await this.rpc('thread/list',{limit:100,sortKey:'updated_at',sourceKinds:[],archived:false,...(cursor?{cursor}:{})});
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
    const messages=[],sourceRoots={},sourceThreads={};
    for(const turn of [...turns.data].reverse())for(const [itemIndex,item] of (turn.items??[]).entries()){
      const position=(turn.startedAt??0)*1000+itemIndex;
      if(item.type==='userMessage'){
        const text=(item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
        // Exclude injected environment/instruction envelopes; do not expose tools/reasoning.
        if(text&&!/^\s*(# AGENTS\.md instructions|<environment_context>)/i.test(text))messages.push({id:item.id,role:'user',text,turnId:turn.id,seq:position,createdAt:position,...(item.clientId?{clientId:item.clientId}:{})});
      }else if(item.type==='agentMessage'&&typeof item.text==='string'){
        messages.push({id:item.id,role:'agent',text:item.text,turnId:turn.id,phase:item.phase??null,seq:position,createdAt:position});
        if(item.phase==='final_answer')sourceThreads[item.id]=[...new Set((turn.items??[]).filter(step=>step.type==='mcpToolCall'&&step.server==='codex_app'&&step.tool==='read_thread'&&step.status==='completed'&&isId(step.arguments?.threadId)).map(step=>step.arguments.threadId))];
        if(item.phase==='final_answer')sourceRoots[item.id]=[...new Set((turn.items??[]).filter(step=>step.type==='commandExecution'&&typeof step.cwd==='string'&&path.isAbsolute(step.cwd)).map(step=>step.cwd))];
      }
    }
    return {thread,messages,sourceRoots,sourceThreads,turns:turns.data.map(turn=>({id:turn.id,status:turn.status,errorObserved:!!turn.error})),nextCursor:turns.nextCursor??null,hasOlder:!!turns.nextCursor};
  }
  close(){this.client.close();}
  async metadata(id){return (await this.rpc('thread/read',{threadId:id,includeTurns:false})).thread;}
}
export class ThreadDirectory {
  constructor({codex,machineId}){Object.assign(this,{codex,machineId});}
  async allowed(device,thread){
    if(!isId(thread?.id)||typeof thread.cwd!=='string'||device.grants.threadIds.length&&!device.grants.threadIds.includes(thread.id))return false;
    // Authoritative Codex metadata remains readable even if its old cwd was moved/deleted.
    return path.isAbsolute(thread.cwd);
  }
  card(thread){return {id:thread.id,threadId:thread.id,sessionId:thread.id,machineId:this.machineId,project:thread.cwd,projectName:path.basename(thread.cwd),projectId:thread.projectId??null,label:thread.name||thread.preview?.slice(0,100)||thread.id,summary:String(thread.preview||'').slice(0,300),updatedAt:thread.updatedAt*1000,state:'desktop',stateVerified:false,desktopState:thread.status?.type??'unknown',source:typeof thread.source==='string'?thread.source:'subAgent',model:thread.model??null,mapping:'native'};}
  async list(device){const rows=await this.codex.list(),result=[];for(const t of rows)if(await this.allowed(device,t))result.push(this.card(t));return result;}
  async readNative(device,id,cursor){await this.authorization(device,id);const {sourceRoots,sourceThreads,...r}=await this.codex.read(id,cursor);if(r.thread?.id!==id||!await this.allowed(device,r.thread))throw fault('ACCESS_DENIED',403);return {...r,thread:undefined,target:this.card(r.thread),completionVerified:false};}
  read(device,id,cursor){return this.readNative(device,id,cursor);}
  async attachmentRoot(device,id,sourceMessageId,file,{native=false}={}){
    return (await this.attachmentSource(device,id,sourceMessageId,file,{native})).project;
  }
  async attachmentSource(device,id,sourceMessageId,file,{native=false}={}){
    await this.authorization(device,id);let result,cursor;const seen=new Set(),until=Date.now()+10000;
    for(let page=0;page<20;page++){result=await this.codex.read(id,cursor);if(result.messages.some(m=>m.id===sourceMessageId))break;if(!result.nextCursor||seen.has(result.nextCursor)||Date.now()>=until)throw fault('DELIVERY_EVIDENCE_REQUIRED',409);seen.add(result.nextCursor);cursor=result.nextCursor;}
    if(result.thread?.id!==id||!await this.allowed(device,result.thread))throw fault('ACCESS_DENIED',403);
    const sources=result.messages.filter(message=>message.role==='agent'&&message.phase==='final_answer'&&explicitArtifactLinks(message.text??'').includes(file));
    if(!sources.some(message=>message.id===sourceMessageId))throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
    const nativeSources=[];for(const target of (result.sourceThreads?.[sourceMessageId]??[]).slice(0,10)){const scope=await this.authorization(device,target);nativeSources.push({project:scope.target.project,sourceThreadId:target});}
    const nativeRoots=nativeSources.map(source=>source.project);
    const roots=[result.thread.cwd,...nativeRoots,...(native?result.sourceRoots?.[sourceMessageId]??[]:sources.flatMap(message=>result.sourceRoots?.[message.id]??[]))].filter(root=>typeof root==='string'&&path.isAbsolute(root)&&root!==path.parse(root).root&&file.startsWith(root+path.sep));
    const root=roots.sort((a,b)=>b.length-a.length)[0];
    if(root){if(await fs.realpath(root)!==root)throw fault('ARTIFACT_PATH_DENIED',403);return {project:root,...(root!==result.thread.cwd?nativeSources.find(source=>source.project===root):{})};}
    // The completed native reply is computer-authored file selection. For a
    // remembered cross-project link, resolve its root from the CURRENT authorized
    // Codex directory, rather than requiring a read_thread tool in this same turn.
    // This cannot turn an arbitrary dirname supplied by the phone into a grant.
    if(native&&typeof this.codex.list==='function'){
      const candidates=(await this.list(device)).filter(t=>t.project!==path.parse(t.project).root&&file.startsWith(t.project+path.sep)).sort((a,b)=>b.project.length-a.project.length);
      for(const candidate of candidates){
        const {target}=await this.authorization(device,candidate.id);
        if(target.project!==candidate.project)continue;
        if(await fs.realpath(target.project)!==target.project)throw fault('ARTIFACT_PATH_DENIED',403);
        return {project:target.project,sourceThreadId:candidate.id};
      }
    }
    throw fault('ARTIFACT_PATH_DENIED',403);
  }
  async authorization(device,id){
    if(!isId(id)||device.grants.threadIds.length&&!device.grants.threadIds.includes(id))throw fault('ACCESS_DENIED',403);
    const metadata=await this.codex.metadata(id).catch(e=>{if(e.status===503||['CODEX_TIMEOUT','CODEX_EXITED','CODEX_START_FAILED'].includes(e.message))throw fault('DIRECTORY_TEMPORARY_UNAVAILABLE',503);throw fault('ACCESS_DENIED',403);});
    if(metadata?.id!==id||!await this.allowed(device,metadata))throw fault('ACCESS_DENIED',403);
    return {target:{id,threadId:id,machineId:this.machineId,project:metadata.cwd}};
  }
}
