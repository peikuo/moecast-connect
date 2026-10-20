import {randomUUID} from 'node:crypto';
import {digest,fault,isId} from './hapi-device-store.mjs';
export function parseAssistantDecision(raw,catalog,projects,{user,focusId}={}){
 let d;try{d=JSON.parse(raw);}catch{throw fault('ASSISTANT_INVALID_OUTPUT',502);}
 // Missing project is resolved by authorization, never by an inferred filesystem path.
 if(d?.intent==='new_thread'&&d.project===null){if(projects.length===1)d.project=projects[0];else d.ambiguous=true;}
 if(d&&catalog.some(t=>t.id===focusId)&&typeof user==='string'){
  const compact=user.replace(/[\s，,。.!！]/g,'');
  if(/^(重新连接)?(恢复|接回|继续)(之前|刚才|原来|当前|这个|原来的)的?(聊天|会话|对话)((不要|别)(新开|新建|另开)(聊天|会话)?)?$/.test(compact)){d.intent='open';d.targetIds=[focusId];d.ambiguous=false;d.project=null;d.alias=null;d.reply='';}
 }
 const ids=new Set(catalog.map(t=>t.id));
 if(!d||!['status','history','dispatch','open','new_thread','alias','none'].includes(d.intent)||typeof d.ambiguous!=='boolean'||!Array.isArray(d.targetIds)||d.targetIds.some(id=>!ids.has(id))||new Set(d.targetIds).size!==d.targetIds.length||d.project!==null&&!projects.includes(d.project)||d.alias!==null&&(typeof d.alias!=='string'||!d.alias.trim()||d.alias.length>80)||typeof d.reply!=='string'||d.reply.length>2000)throw fault('ASSISTANT_INVALID_OUTPUT',502);
 if(!d.ambiguous&&(['dispatch','open','alias','history'].includes(d.intent)&&d.targetIds.length!==1||d.intent==='status'&&!d.targetIds.length||d.intent==='new_thread'&&(!d.project||d.targetIds.length)||d.intent==='none'&&d.targetIds.length||d.intent==='alias'&&!d.alias))throw fault('ASSISTANT_INVALID_OUTPUT',502);
 // Exact duplicate names/aliases cannot be disambiguated by model preference.
 if(typeof user==='string'&&d.targetIds.length===1&&!d.ambiguous&&d.intent!=='new_thread'){
  const normalize=s=>s.normalize('NFKC').toLocaleLowerCase();const text=normalize(user),chosen=catalog.find(t=>t.id===d.targetIds[0]);
  const terms=[chosen.label,...(chosen.aliases??[])].filter(n=>n&&text.includes(normalize(n))).sort((a,b)=>b.length-a.length);
  if(terms.length&&!text.includes(chosen.id)){
   const term=normalize(terms[0]),matches=catalog.filter(t=>[t.label,...(t.aliases??[])].some(n=>normalize(n)===term));
   const qualified=matches.filter(t=>text.includes(normalize(t.project))||text.includes(normalize(t.project.split('/').filter(Boolean).at(-1))));
   if(matches.length>1&&!(qualified.length===1&&qualified[0].id===chosen.id)){d.ambiguous=true;d.targetIds=matches.map(t=>t.id);}
  }
 }
 return d;
}
export class DeviceAssistant {
 constructor({store,directory,model,gateway,now=Date.now}){Object.assign(this,{store,directory,model,gateway,now});this.queues=new Map();this.catalogPromise=null;}
 serial(deviceId,action){const result=(this.queues.get(deviceId)??Promise.resolve()).then(action);const tail=result.catch(()=>{});this.queues.set(deviceId,tail);tail.finally(()=>{if(this.queues.get(deviceId)===tail)this.queues.delete(deviceId);});return result;}
 preferences(id){return this.store.require(id).assistant??{model:null,focusId:null,aliases:{},conversation:[]};}
 async savePreferences(id,patch){return this.store.transaction(async()=>{const d=this.store.require(id);d.assistant={...this.preferences(id),...patch};await this.store.save();return structuredClone(d.assistant);});}
 async models(){if(!this.catalogPromise)this.catalogPromise=this.model.models().finally(()=>{this.catalogPromise=null});return this.catalogPromise;}
 async configuration(id){const p=this.preferences(id),models=await this.models();return{model:p.model,suggestedModel:models.some(m=>m.id==='gpt-6-luna')?'gpt-6-luna':null,selectionRequired:!p.model||!models.some(m=>m.id===p.model),models,focusId:p.focusId,scope:'frontdesk_only',workModelsUnchanged:true};}
 async configure(id,model){if(typeof model!=='string'||!(await this.models()).some(m=>m.id===model))throw fault('MODEL_NOT_AVAILABLE');await this.savePreferences(id,{model});return this.configuration(id);}
 async catalog(id){const device=this.store.require(id),p=this.preferences(id);const rows=await this.directory.list(device);return rows.map(t=>({...t,aliases:p.aliases?.[t.id]??[]}));}
 request(id,requestId){return this.store.data.assistantRequests?.[id+':'+requestId];}
 async persist(id,requestId,entry){await this.store.transaction(async()=>{this.store.require(id);this.store.data.assistantRequests??={};this.store.data.assistantRequests[id+':'+requestId]=entry;await this.store.save();});}
 turn(id,input){return this.serial(id,()=>this.perform(id,input));}
 async perform(id,{text,requestId,focusId}){
  if(typeof text!=='string'||!text.trim()||text.length>8000||typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(requestId)||focusId!==undefined&&!isId(focusId))throw fault('INVALID_ASSISTANT_REQUEST');
  const hash=digest(JSON.stringify([text,focusId??null])),prior=this.request(id,requestId);
  if(prior){if(prior.digest!==hash)throw fault('REQUEST_ID_CONFLICT',409);return this.publicRequest(prior,requestId);}
  const p=this.preferences(id),configuration=await this.configuration(id);if(configuration.selectionRequired)return{kind:'model_selection_required',...configuration};
  const catalog=await this.catalog(id),device=this.store.require(id),projects=device.grants.projects;
  const focus=focusId??p.focusId;const safeFocus=catalog.some(t=>t.id===focus)?focus:null;
  const answer=await this.model.infer({user:text,catalog:catalog.map(({id,label,project,projectName,summary,state,aliases})=>({id,label,project,projectName,summary,state,aliases})),projects,focusId:safeFocus,conversation:(p.conversation??[]).slice(-4)},p.model);
  this.store.require(id);const decision=parseAssistantDecision(answer.raw,catalog,projects,{user:text,focusId:safeFocus});
  const entry={digest:hash,text,decision,createdAt:this.now(),expiresAt:this.now()+300000,state:'prepared',projects:[...projects],offered:decision.targetIds.length?catalog.filter(t=>decision.targetIds.includes(t.id)):catalog};
  // Persist interpretation before any effect; a process restart never reruns a mutation.
  await this.persist(id,requestId,entry);
  if(decision.ambiguous){entry.state='selection_required';await this.persist(id,requestId,entry);return this.publicRequest(entry,requestId);}
  return this.execute(id,requestId,entry,decision.targetIds,decision.project);
 }
 publicRequest(entry,requestId){
  if(entry.result)return structuredClone(entry.result);
  if(entry.state==='selection_required')return{kind:'selection_required',action:entry.decision.intent,ticket:requestId,candidates:entry.offered,speech:null,expiresAt:entry.expiresAt,projects:entry.decision.intent==='new_thread'?entry.projects:undefined};
  return{kind:entry.state==='cancelled'?'cancelled':'reconciliation_required',requestId,automaticRetry:false};
 }
 select(id,{ticket,threadId,project}){return this.serial(id,async()=>{
  const e=this.request(id,ticket);if(!e||e.state==='cancelled'||e.expiresAt<=this.now())throw fault('SELECTION_EXPIRED',409);
  if(e.selectedId&&e.selectedId!==threadId||e.selectedProject&&e.selectedProject!==project)throw fault('SELECTION_ALREADY_USED',409);
  if(e.result)return structuredClone(e.result);
  if(e.state!=='selection_required')throw fault('SELECTION_NOT_PENDING',409);
  const current=await this.catalog(id);
  if(e.decision.intent==='new_thread'){if(!this.store.require(id).grants.projects.includes(project))throw fault('ACCESS_DENIED',403);}
  else {const old=e.offered.find(t=>t.id===threadId),fresh=current.find(t=>t.id===threadId);if(!old||!fresh||old.machineId!==fresh.machineId||old.project!==fresh.project)throw fault('TARGET_CHANGED',409);}
  e.selectedId=threadId;e.selectedProject=project;await this.persist(id,ticket,e);return this.execute(id,ticket,e,threadId?[threadId]:[],project??e.decision.project);
 });}
 cancel(id,{ticket}){return this.serial(id,async()=>{const e=this.request(id,ticket);if(!e||e.state!=='selection_required')throw fault('SELECTION_NOT_PENDING',409);e.state='cancelled';await this.persist(id,ticket,e);return{cancelled:true};});}
 async execute(id,requestId,entry,targetIds,project){
  const d=entry.decision;let result;
  entry.state='executing';await this.persist(id,requestId,entry);
  try{
   if(d.intent==='dispatch'){
    const receipt=await this.gateway.dispatch(id,targetIds[0],entry.text,'as_'+digest(requestId));result={kind:'submitted',requestId,targetId:targetIds[0],receipt,text:receipt.state==='accepted'?'指令已交给目标聊天。':'尚未确认送达，将保留回执核对。',completed:false};
   }else if(d.intent==='open'){
    const opened=await this.directory.open(this.store.require(id,'dispatch'),targetIds[0],{allowBusy:true});result={kind:'opened',target:opened.target,sessionId:opened.session.id};
   }else if(d.intent==='new_thread'){
    // No reconnect, implicit focus, or model-invented ID can enter this path.
    if(!/(新建|新开|另开|创建.{0,6}(聊天|会话|thread)|开.{0,4}新)/i.test(entry.text))throw fault('EXPLICIT_NEW_THREAD_REQUIRED',409);
    result={kind:'created',...(await this.directory.create(this.store.require(id,'dispatch'),{project}))};
   }else if(d.intent==='alias'){
    const p=this.preferences(id),aliases={...p.aliases,[targetIds[0]]:[...new Set([...(p.aliases?.[targetIds[0]]??[]),d.alias.trim()])].slice(-10)};await this.savePreferences(id,{aliases});result={kind:'alias_saved',targetId:targetIds[0],alias:d.alias};
   }else if(d.intent==='status'||d.intent==='history'){
    const facts=await Promise.all(targetIds.map(async tid=>{const r=await this.directory.read(this.store.require(id),tid);return{target:r.target,messages:d.intent==='history'?r.messages:r.messages.slice(-6),hasOlder:r.hasOlder||d.intent==='status'&&r.messages.length>6,observedAt:new Date(this.now()).toISOString(),completionVerified:false};}));
    const states={working:'正在处理',waiting_permission:'等待电脑端处理权限',idle:'当前待命',resumable:'当前未运行，可恢复',mapping_conflict:'聊天映射需要核对'};
    const text=facts.map(f=>`${f.target.label}：${states[f.target.state]??'状态未确认'}。${f.messages.findLast(m=>m.role==='agent')?`最近回复：“${f.messages.findLast(m=>m.role==='agent').text.slice(0,400)}”`:'暂时没有回复。'}完成情况未独立核实。`).join('\n');result={kind:d.intent,facts,text,readOnly:true,completionVerified:false};
   }else result={kind:'reply',text:d.reply||'我可以查看电脑聊天的进度，或把你的指令交给指定聊天。',dispatched:false};
   this.store.require(id);entry.state='completed';entry.result=result;await this.persist(id,requestId,entry);
   const target=targetIds.length===1?targetIds[0]:result.target?.id??null;
   const p=this.preferences(id);await this.savePreferences(id,{...(target?{focusId:target}:{}),conversation:[...(p.conversation??[]),{user:entry.text,result:{kind:result.kind,targetIds}}].slice(-4)});return structuredClone(result);
  }catch(e){entry.state='reconciliation_required';entry.error=/^[A-Z_]+$/.test(e.message)?e.message:'ASSISTANT_FAILED';await this.persist(id,requestId,entry);throw e;}
 }
}
