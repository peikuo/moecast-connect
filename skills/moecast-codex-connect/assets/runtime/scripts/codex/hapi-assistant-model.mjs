// Explicit weather/sleep domain calls only. Never used to plan phone chat operations.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const{Codex}=createRequire(import.meta.url)('./codex.cjs');
export class AssistantModel {
 constructor(root){this.root=root;}
 async models(){const c=new Codex(this.root,()=>{});try{await c.connect();const r=await c.rpc('model/list',{includeHidden:false});return(r.data??[]).map(m=>({id:m.model||m.id,name:m.displayName||m.model||m.id,isDefault:!!m.isDefault}));}finally{c.close();}}
 async run(input,model,{instructions,schema,promptVersion,signal,conversationThread,allowWebSearch=false}={}){
  if(typeof instructions!=='string'||!instructions.trim()||!schema||typeof promptVersion!=='string')throw Error('DOMAIN_INSTRUCTIONS_REQUIRED');
  const c=new Codex(this.root,()=>{});let timer,threadId;const cancel=()=>{if(c.run)c.cancel(c.run.id);else c.close('ASSISTANT_MODEL_CANCELLED');};signal?.throwIfAborted();signal?.addEventListener('abort',cancel,{once:true});
  try{
   await c.connect();signal?.throwIfAborted();
   // Disable inherited tools and integrations in this dedicated model thread only.
   const current=(await c.rpc('config/read',{includeLayers:false})).config??{};
   model??=current.model;
   const searchEnabled=!!conversationThread&&allowWebSearch;
   const webSearch=[];
   const config={web_search:searchEnabled?'live':'disabled',project_doc_max_bytes:0,features:{shell_tool:false,multi_agent:false,memories:false,hooks:false},tools:{view_image:false},apps:{_default:{enabled:false}},mcp_servers:{},plugins:{}};
   for(const id of Object.keys(current.mcp_servers??{}))config.mcp_servers[id]={enabled:false};
   for(const id of Object.keys(current.apps??{}))config.apps[id]={enabled:false};
   for(const id of Object.keys(current.plugins??{}))config.plugins[id]={enabled:false};
   const options={cwd:c.cwd,model,approvalPolicy:'never',sandbox:'read-only',config};
   if(conversationThread?.id){
    const resumed=await c.rpc('thread/resume',{...options,threadId:conversationThread.id,excludeTurns:true});threadId=resumed.thread.id;
    if(threadId!==conversationThread.id)throw Error('SLEEP_THREAD_IDENTITY_MISMATCH');
    await c.rpc('thread/inject_items',{threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:instructions}]}]});
   }else{
    const started=await c.rpc('thread/start',{...options,ephemeral:!conversationThread,baseInstructions:instructions,developerInstructions:instructions});threadId=started.thread.id;
    if(conversationThread){await conversationThread.created(threadId);await c.rpc('thread/name/set',{threadId,name:conversationThread.name});}
   }
   let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b});done.catch(()=>{});
   c.run={id:randomUUID(),threadId,messages:[],model,toolNames:new Set(),resolve,reject,cancelled:false};
   const receive=c.receive.bind(c);c.receive=message=>{
    if(message.params?.threadId===threadId){
     const item=message.params.item;
     if(message.method==='item/started'&&!['userMessage','agentMessage','reasoning','contextCompaction',...(searchEnabled?['webSearch']:[])].includes(item?.type)){reject(Error('ASSISTANT_TOOL_BLOCKED'));c.close();return;}
     if(message.method==='item/completed'&&item?.type==='webSearch'&&searchEnabled)webSearch.push(structuredClone(item));
    }
    receive(message);
   };
   timer=setTimeout(()=>c.close('ASSISTANT_MODEL_TIMEOUT'),searchEnabled?80000:60000);
   await c.rpc('turn/start',{threadId,input:[{type:'text',text:JSON.stringify(input)}],model,effort:'low',outputSchema:schema});
   const answer=await done;signal?.throwIfAborted();if(answer.cancelled)throw Error('ASSISTANT_MODEL_CANCELLED');return{raw:answer.text,model,promptVersion,...(conversationThread?{threadId,webSearch}:{})};
  }finally{signal?.removeEventListener('abort',cancel);clearTimeout(timer);c.close();}
 }
}
