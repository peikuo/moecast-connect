import {randomUUID} from 'node:crypto';
import {findNativeRequest} from './native-request.mjs';
import {digest,fault,isId} from './hapi-device-store.mjs';
const requestIdValid=id=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,100}$/.test(id);
/** One bound desktop inbox. This transport never plans work or starts a Codex execution. */
export class FixedHapiAssistant {
 constructor({store,directory,model,desktopInbox,prepareAttachments,now=Date.now,replyWaitMs=75000,pollMs=750}){
  if(typeof desktopInbox!=='function')throw fault('DESKTOP_INBOX_REQUIRED',500);
  Object.assign(this,{store,directory,model,desktopInbox,prepareAttachments,now,replyWaitMs,pollMs});this.queues=new Map();this.active=new Set();this.reconciliations=new Map();
 }
 serial(id,action){const result=(this.queues.get(id)??Promise.resolve()).then(action);const tail=result.catch(()=>{});this.queues.set(id,tail);tail.finally(()=>{if(this.queues.get(id)===tail)this.queues.delete(id)});return result;}
 preferences(id){return this.store.require(id).assistant??{};}
 async configuration(id){return{model:null,models:[],selectionRequired:false,scope:'desktop_native',managedBy:'desktop',bindingRequired:!this.preferences(id).frontdeskThreadId,workModelsUnchanged:true};}
 configure(){throw fault('MODEL_MANAGED_BY_DESKTOP',409);}
 request(id,requestId){return this.store.data.assistantRequests?.[id+':'+requestId];}
 async persist(id,requestId,entry){await this.store.transaction(async()=>{this.store.require(id);this.store.data.assistantRequests??={};this.store.data.assistantRequests[id+':'+requestId]=entry;await this.store.save();});}
 async deliverReply(id,entry){
  if(!this.prepareAttachments||entry.result?.kind!=='reply'||entry.result.attachmentDelivery?.state==='ready')return structuredClone(entry.result);
  try{
   const delivery=await this.prepareAttachments(id,entry.requestId);
   if(delivery)entry.result.attachmentDelivery=delivery;
  }catch(error){entry.result.attachmentDelivery={version:1,state:'failed',artifacts:[],blocked:[],errors:[{code:/^[A-Z_]+$/.test(error.message)?error.message:'ARTIFACT_UNAVAILABLE'}]};}
  await this.persist(id,entry.requestId,entry);return structuredClone(entry.result);
 }
 async complete(id,entry,result){
  // Save exact native correlation first so attachment preparation can verify it.
  // A crash here recovers through reconcile without submitting the message again.
  entry.result=result;entry.state='completed';await this.persist(id,entry.requestId,entry);return this.deliverReply(id,entry);
 }
 async binding(id,requested){
  const old=this.preferences(id).frontdeskThreadId;
  if(requested!==undefined&&!isId(requested))throw fault('INVALID_FRONTDESK_BINDING');
  if(old&&requested&&old!==requested)throw fault('FIXED_FRONTDESK_CHANGED',409);
  if(!old)throw fault('FIXED_FRONTDESK_REQUIRED',409);
  await this.directory.authorization(this.store.require(id),old);return old;
 }
 turn(id,input){return this.serial(id,()=>this.perform(id,input));}
 pending(requestId,reason='DESKTOP_REPLY_PENDING'){return{kind:'reconciliation_required',requestId,reason,text:'桌面回复尚未确认，稍后会继续核对。',speech:null,automaticRetry:false};}
 async perform(id,{text,requestId,frontdeskThreadId,locale='zh-CN'}){
  if(typeof text!=='string'||!text.trim()||text.length>8000||!requestIdValid(requestId))throw fault('INVALID_ASSISTANT_REQUEST');
  if(!['zh-CN','en-US'].includes(locale))throw fault('INVALID_LOCALE');
  this.store.require(id,'dispatch');
  const fixed=await this.binding(id,frontdeskThreadId),prior=this.request(id,requestId);
  if(prior){if(prior.text!==text)throw fault('REQUEST_ID_CONFLICT',409);return this.reconcile(id,requestId);}
  const entry={requestId,digest:digest(JSON.stringify([text,null])),text,createdAt:this.now(),state:'prepared',locale,frontdeskThreadId:fixed,nativeMessageId:randomUUID(),transport:'desktop_native'};
  await this.persist(id,requestId,entry);this.active.add(id+':'+requestId);
  try{
   entry.desktopReceipt=await this.desktopInbox(fixed).send({text,locale,localId:entry.nativeMessageId,onAttempt:async()=>{entry.coordinatorAttemptedAt=this.now();entry.state='coordinating';await this.persist(id,requestId,entry);}});
   await this.persist(id,requestId,entry);const until=Date.now()+this.replyWaitMs;
   do{
    this.store.require(id);
    try{const result=await this.readReply(id,entry);if(result)return await this.complete(id,entry,result);}catch{/* Reads may be retried; submitted user input may not. */}
    if(Date.now()>=until)break;await new Promise(r=>setTimeout(r,this.pollMs));
   }while(Date.now()<until);
   entry.result=this.pending(requestId);entry.state='reconciliation_required';await this.persist(id,requestId,entry);return structuredClone(entry.result);
  }catch(error){
   entry.result=entry.coordinatorAttemptedAt?this.pending(requestId,/^[A-Z_]+$/.test(error.message)?error.message:'DESKTOP_DELIVERY_UNCONFIRMED'):{kind:'temporarily_unavailable',requestId,reason:/^[A-Z_]+$/.test(error.message)?error.message:'DESKTOP_INBOX_UNAVAILABLE',text:'桌面 Codex 尚未连接，消息未发出。请确认电脑未休眠、Codex 已打开。',speech:null,automaticRetry:false};
   entry.state=entry.coordinatorAttemptedAt?'reconciliation_required':'completed';await this.persist(id,requestId,entry);return structuredClone(entry.result);
  }finally{this.active.delete(id+':'+requestId);}
 }
 async readReply(id,entry){
  const found=await findNativeRequest(this.directory,this.store.require(id),entry.frontdeskThreadId,entry.nativeMessageId);this.store.require(id);
  if(!found||!found.turn)return;
  if(found.turn.status==='failed'&&found.turn.errorObserved===true)return{kind:'delivery_failed',confirmedFailure:true,requestId:entry.requestId,text:'桌面 Codex 未能完成这次回复，请回电脑查看。',speech:null,automaticRetry:false,source:{transport:'desktop_native',threadId:entry.frontdeskThreadId,nativeMessageId:entry.nativeMessageId,turnId:found.turn.id,finalMessageIds:[]}};
  if(found.turn.status!=='completed')return;
  const finals=found.history.messages.filter(m=>m.turnId===found.turn.id&&m.role==='agent'&&m.phase==='final_answer');if(!finals.length)return;
  return{kind:'reply',text:finals.map(m=>m.text).join('\n'),source:{transport:'desktop_native',threadId:entry.frontdeskThreadId,nativeMessageId:entry.nativeMessageId,turnId:found.turn.id,finalMessageIds:finals.map(m=>m.id)}};
 }
 async reconcile(id,requestId){
  if(!requestIdValid(requestId))throw fault('INVALID_ASSISTANT_REQUEST');this.store.require(id);
  const key=id+':'+requestId;if(this.reconciliations.has(key))return this.reconciliations.get(key);
  const entry=this.request(id,requestId);if(!entry)throw fault('REQUEST_NOT_FOUND',404);
  const needsEvidence=entry.transport==='desktop_native'&&(entry.result?.kind==='reply'&&!entry.result.source||entry.result?.kind==='delivery_failed'&&!entry.result.confirmedFailure);
  if(!needsEvidence&&(entry.state==='completed'||entry.transport!=='desktop_native'))return entry.result?.kind==='reply'&&entry.transport==='desktop_native'?this.deliverReply(id,entry):structuredClone(entry.result??this.pending(requestId));
  if(this.active.has(key))return structuredClone(entry.result??this.pending(requestId));
  if(needsEvidence&&entry.result?.kind==='delivery_failed'){entry.result=this.pending(requestId);entry.state='reconciliation_required';await this.persist(id,requestId,entry);}
  if(entry.state==='prepared'&&entry.coordinatorAttemptedAt===undefined&&!entry.desktopReceipt){entry.state='completed';entry.result={kind:'temporarily_unavailable',requestId,reason:'DELIVERY_NOT_ATTEMPTED',text:'连接在发送前已中断，这次消息未发出。',speech:null,automaticRetry:false};await this.persist(id,requestId,entry);return structuredClone(entry.result);}
  const action=(async()=>{try{const result=await this.readReply(id,entry);if(result)return await this.complete(id,entry,result);}catch{/* Keep uncertain writes recoverable, without resending. */}return structuredClone(entry.result??this.pending(requestId));})();
  this.reconciliations.set(key,action);try{return await action;}finally{this.reconciliations.delete(key);}
 }
}
