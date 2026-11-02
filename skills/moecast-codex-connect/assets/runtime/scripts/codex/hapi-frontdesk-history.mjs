// User-facing conversation journal, distinct from raw worker thread history.
import {digest,fault} from './hapi-device-store.mjs';
const valid=id=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,100}$/.test(id);
export function frontdeskReply(result){
  if(result?.kind==='submitted'){
    const receipt=result.receipt;
    if(receipt?.state==='accepted')return `已把指令交给「${result.target?.label??'目标聊天'}」。`;
    if(receipt?.state==='not_sent'&&receipt.error==='DESKTOP_BRIDGE_REJECTED')return '这次指令没有发出。桌面拒绝了连接服务的消息入口，请回电脑原聊天继续。';
    if(receipt?.state==='not_sent'&&/^DESKTOP_/.test(receipt.error??''))return '这次指令没有发出。桌面消息入口尚未连通，请在电脑恢复 MoeCast 连接。';
    if(receipt?.state==='not_sent'&&receipt.error==='TARGET_IN_USE')return '这次指令没有发出。电脑上的 Codex 正在占用这个聊天，请回电脑原聊天继续。';
    if(receipt?.state==='not_sent'&&receipt.error==='TARGET_RESUME_FAILED')return '这次指令没有发出。电脑没能恢复目标聊天，请在电脑打开原聊天后再处理。';
    if(receipt?.state==='not_sent'&&receipt.error==='HAPI_TEMPORARY_UNAVAILABLE')return '这次指令没有发出。电脑暂时无法接收，请到电脑查看目标聊天。';
    if(receipt?.state==='not_sent')return receipt.error==='TARGET_WAITING_PERMISSION'?'目标聊天正在等待权限确认，这次指令没有发出。请在电脑处理该聊天的权限请求后，再明确发送；手机不会自动批准或重发。':receipt.error==='TARGET_NOT_READY'?'目标聊天当时正在工作或等待权限确认，这次指令没有发出。请先查看该聊天的状态，再明确发送。':'这次指令没有发出，请检查电脑连接和目标聊天状态后再明确发送。';
    return '尚未确认是否送达，将保留回执核对，不会自动重发。';
  }
  if(['reply','analysis'].includes(result?.kind)&&result.analysis?.version===1&&result.readOnly===true&&typeof result.text==='string')return result.text;
  if(['status','history'].includes(result?.kind)){
    const states={working:'正在处理',waiting_permission:'等待电脑端处理权限',idle:'当前待命',resumable:'当前未运行，可恢复',mapping_conflict:'聊天映射需要核对'};
    if(Array.isArray(result.facts))return result.facts.map(f=>{
      const verified=f.stateVerified??f.target.stateVerified,reply=f.information?.agentReplyObserved??f.messages?.some(m=>m.role==='agent'&&m.text?.trim());
      const state=verified===false?'当前状态尚未核实':states[f.target.state]??'状态未确认';
      const detail=f.historyUnavailable?'该聊天的记录暂时无法读取。':reply?'已读到工作回复，但尚未生成成果总结，详细内容可回电脑查看。':f.hasOlder?'本次读取范围内未看到工作回复，尚有更早记录未读取，不能判断完整历史中有没有。':'当前可读取记录中暂未看到工作回复。';
      return `${f.target.label}：${state}。${detail}完成情况未独立核实。`;
    }).join('\n');
    return '目前只能确认工作状态，详细结果请回电脑查看；完成情况未独立核实。';
  }
  const labels={opened:'已接回原来的聊天。',created:'已创建新的聊天。',alias_saved:'已记住这个称呼。',selection_required:'请选一下要交给哪个目标。',cancelled:'已取消，这次没有派活。',model_selection_required:'请先选择我的前台模型。',reconciliation_required:'这次操作的结果还没有确认，我会保留请求供核对。'};
  return typeof result?.text==='string'?result.text:labels[result?.kind]??'操作状态已更新。';
}
function safeResult(result){
  // Deliberately exclude worker facts/history and their raw messages from this journal.
  const value={kind:result.kind,text:frontdeskReply(result)};
  for(const key of ['requestId','ticket','action','targetId','receipt','expiresAt','speech','automaticRetry','completed','dispatched','alias','target','candidates','projects','summaryAvailable','completionVerified','reason','stage','retryable','canRetrySameRequest','information','analysis','readOnly','analysisUnavailable','analysisError','source','confirmedFailure','attachmentDelivery'])if(result[key]!==undefined)value[key]=structuredClone(result[key]);
  if(value.receipt){delete value.receipt.baselineMessageIds;delete value.receipt.digest;delete value.receipt.requestDigest;}
  return value;
}
export class FrontdeskHistory {
  constructor({store,now=Date.now}){Object.assign(this,{store,now});this.queues=new Map();}
  serial(id,action){const task=(this.queues.get(id)??Promise.resolve()).then(action);const tail=task.catch(()=>{});this.queues.set(id,tail);tail.finally(()=>{if(this.queues.get(id)===tail)this.queues.delete(id);});return task;}
  async save(id,key,patch){return this.store.transaction(async()=>{
    this.store.require(id);this.store.data.frontdeskHistory??={};
    const journal=this.store.data.frontdeskHistory[id]??={sequence:0,entries:{}};
    const entryKey='r:'+key,prior=journal.entries[entryKey]??(Object.hasOwn(journal.entries,key)?journal.entries[key]:undefined);
    const row={...prior,...patch,requestId:key,sequence:prior?.sequence??++journal.sequence,updatedAt:this.now()};
    delete journal.entries[key];journal.entries[entryKey]=row;await this.store.save();return structuredClone(row);
  });}
  run(id,method,input,execute){return this.serial(id,async()=>{
    if(method!=='turn')throw fault('RETIRED_ASSISTANT_ACTION',410);
    const key=input.requestId;
    if(!valid(key))throw fault('INVALID_ASSISTANT_REQUEST');
    const entries=this.store.data.frontdeskHistory?.[id]?.entries??{};
    const prior=entries['r:'+key]??(Object.hasOwn(entries,key)?entries[key]:undefined);
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>8000)throw fault('INVALID_ASSISTANT_REQUEST');
    const hash=digest(JSON.stringify([input.text,input.focusId??null]));
    if(prior&&prior.inputDigest!==hash)throw fault('REQUEST_ID_CONFLICT',409);
    await this.save(id,key,{text:input.text,focusId:input.focusId,inputDigest:hash,createdAt:prior?.createdAt??this.now(),state:prior?.state??'pending'});
    try{
      const result=await execute();
      await this.save(id,key,{state:result.cancelled?'cancelled':result.kind==='selection_required'?'selection_required':result.kind==='reconciliation_required'?'unknown':'responded',result:safeResult(result.cancelled?{kind:'cancelled'}:result),error:null});
      return result;
    }catch(error){await this.save(id,key,{state:error.status>=400&&error.status<500&&prior?prior.state:'unknown',error:/^[A-Z_]+$/.test(error.message)?error.message:'ASSISTANT_FAILED'});throw error;}
  });}
  async reconcile(id,input,resolve){
    const rows=this.list(id,input).entries.filter(r=>r.reconcilePending===true);
    for(const row of rows){const request=this.store.data.assistantRequests?.[id+':'+row.requestId];if(request?.transport!=='desktop_native')continue;const result=await resolve(row.requestId);if(result&&(result.kind!=='reconciliation_required'||row.state==='responded'))await this.save(id,row.requestId,{state:result.kind==='reconciliation_required'?'unknown':'responded',result:safeResult(result),error:null});}
  }
  async clear(id){
    return this.store.transaction(async()=>{
      this.store.require(id);let cleared=0;
      for(const row of Object.values(this.store.data.frontdeskHistory?.[id]?.entries??{})){
        if(row.hidden===true)continue;
        row.hidden=true;row.hiddenReason='user-cleared-history';cleared++;
      }
      // Keep request/receipt evidence so clearing the display cannot repeat a task.
      await this.store.save();return {...this.list(id,{limit:20}),cleared};
    });
  }
  list(id,{beforeSequence,limit=50}={}){
    this.store.require(id);
    if(!Number.isInteger(limit)||limit<1||limit>100||beforeSequence!==undefined&&(!Number.isSafeInteger(beforeSequence)||beforeSequence<1))throw fault('INVALID_HISTORY_CURSOR');
    const all=Object.values(this.store.data.frontdeskHistory?.[id]?.entries??{});
    const hiddenRequestIds=all.filter(r=>r.hidden===true).map(r=>r.requestId);
    const rows=all.filter(r=>r.hidden!==true&&(beforeSequence===undefined||r.sequence<beforeSequence)).sort((a,b)=>b.sequence-a.sequence);
    const selected=rows.slice(0,limit).map(({inputDigest,...row})=>{const value=structuredClone(row);value.reconcilePending=(['pending','unknown'].includes(row.state)||row.result?.kind==='delivery_failed'&&!row.result.confirmedFailure)&&this.store.data.assistantRequests?.[id+':'+row.requestId]?.transport==='desktop_native';if(value.result?.kind==='submitted')value.result.text=frontdeskReply(value.result);return value;});
    return {entries:selected.reverse(),hiddenRequestIds,hasOlder:rows.length>limit,nextBeforeSequence:rows.length>limit?selected[0]?.sequence??null:null,serverTime:this.now(),completionVerified:false};
  }
}
