import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {DeviceStore,digest,fault,isId} from './hapi-device-store.mjs';
import {TargetSelection,selectionBinding} from './hapi-targets.mjs';
import {projectMessages} from './hapi-directory.mjs';
const validRequest=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
const safeSession=s=>({id:s.id,active:!!s.active,thinking:!!s.thinking,model:s.model??null,permissionMode:s.permissionMode,
  metadata:{path:s.metadata.path,machineId:s.metadata.machineId,codexSessionId:s.metadata.codexThreadId||s.metadata.codexSessionId,name:s.metadata.name},
  agentState:{requests:Object.fromEntries(Object.entries(s.agentState?.requests??{}).map(([id,r])=>[id,{tool:String(r.tool||'Tool')}]))}});
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fault('JSON_REQUIRED',415);
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>65536)throw fault('BODY_TOO_LARGE',413);chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('INVALID_JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw fault('INVALID_JSON');return value;
}
export class DeviceGateway {
  constructor({store,directory,hapi,assistant,now=Date.now}){
    this.assistant=assistant;this.store=store;this.directory=directory;this.hapi=hapi;this.now=now;this.tokens=new Map();this.routers=new Map();this.streams=new Map();this.threadQueues=new Map();this.failures=[];
    store.listeners.add(id=>{for(const [key,v]of this.tokens)if(v.id===id)this.tokens.delete(key);this.routers.delete(id);for(const res of this.streams.get(id)??[])res.end();this.streams.delete(id);});
    this.server=http.createServer((req,res)=>{this.handle(req,res).catch(e=>{
      if(res.headersSent){res.end();return;}
      const selectionError=/^(SELECTION_|TARGET_|REQUEST_ID_CONFLICT|INVALID_DISPATCH|TOO_MANY_SELECTIONS)/.test(e.message||'');
      if(!e.status&&!selectionError)console.error(JSON.stringify({event:'gateway_internal_error',type:e.name,code:/^[A-Z_]+$/.test(e.message||'')?e.message:'UNEXPECTED_ERROR',frames:String(e.stack||'').split('\n').slice(1,3)}));
      this.reply(res,e.status??(selectionError?409:502),{error:e.status||selectionError?e.message:'BACKEND_UNAVAILABLE'});
    });});
    this.server.requestTimeout=100000;this.server.headersTimeout=15000;
  }
  reply(res,status,value){if(status<400&&res.deviceId)this.store.require(res.deviceId);res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
  authenticate(req){
    const token=req.headers.authorization?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/)?.[1],record=token&&this.tokens.get(digest(token));
    if(!record||record.expiresAt<=this.now())throw fault('PAIRING_REQUIRED',401);
    return this.store.require(record.id);
  }
  limit(){this.failures=this.failures.filter(t=>t>this.now()-60000);if(this.failures.length>=30)throw fault('TOO_MANY_ATTEMPTS',429);}
  router(device){
    if(!this.routers.has(device.id))this.routers.set(device.id,new TargetSelection({
      list:()=>this.directory.list(this.store.require(device.id)),
      dispatch:(id,text,requestId)=>this.dispatch(device.id,id,text,requestId),
    },{uuid:randomUUID,now:this.now}));return this.routers.get(device.id);
  }
  serial(thread,action){const result=(this.threadQueues.get(thread)??Promise.resolve()).then(action);const tail=result.catch(()=>{});this.threadQueues.set(thread,tail);tail.finally(()=>{if(this.threadQueues.get(thread)===tail)this.threadQueues.delete(thread);});return result;}
  dispatch(deviceId,threadId,text,requestId){return this.serial(threadId,async()=>{
    const device=this.store.require(deviceId,'dispatch');
    if(!isId(threadId)||typeof text!=='string'||!text.trim()||text.length>32000||!validRequest(requestId))throw fault('INVALID_DISPATCH');
    await this.directory.read(device,threadId);
    const key=deviceId+':'+requestId,hash=digest(JSON.stringify([threadId,text]));
    const previous=this.store.data.outbox[key];
    if(previous){if(previous.digest!==hash)throw fault('REQUEST_ID_CONFLICT',409);return structuredClone(previous);}
    const binding=this.routers.get(deviceId)?.pending.get(requestId)?.binding;
    const receipt={threadId,requestId,digest:hash,requestDigest:binding?digest(binding):null,localId:randomUUID(),state:'pending',completed:false};
    await this.store.transaction(async()=>{this.store.require(deviceId,'dispatch');this.store.data.outbox[key]=receipt;await this.store.save();});
    try{
      const {session}=await this.directory.open(this.store.require(deviceId,'dispatch'),threadId);
      if(session.thinking||Object.keys(session.agentState?.requests??{}).length)throw fault('TARGET_NOT_READY',409);
      receipt.sessionId=session.id;
      // Re-check revocation after all async mapping/resume operations and before sending.
      this.store.require(deviceId,'dispatch');
      await this.store.transaction(()=>this.store.save());
      const result=await this.hapi.json(`/api/sessions/${session.id}/messages`,'POST',{text,localId:receipt.localId});
      receipt.state=result.ok===true?'accepted':'unknown';
    }catch(error){receipt.state=receipt.sessionId?'unknown':'not_sent';receipt.error=error.status||/^HAPI_[A-Z_]+$/.test(error.message||'')?error.message:'BACKEND_UNAVAILABLE';}
    await this.store.transaction(()=>this.store.save());return structuredClone(receipt);
  });}
  async reconcile(device,requestId){
    if(!validRequest(requestId))throw fault('INVALID_REQUEST');const receipt=this.store.data.outbox[device.id+':'+requestId];
    if(!receipt)throw fault('NOT_FOUND',404);
    await this.directory.read(device,receipt.threadId);
    if(!receipt.sessionId)return {...receipt,verifiedInHistory:false};
    const {session}=await this.directory.resolveSession(device,receipt.sessionId);
    const result=await this.hapi.json(`/api/sessions/${session.id}/messages?limit=200`);
    const found=result.messages?.some(m=>m.localId===receipt.localId&&m.content?.role==='user'&&digest(JSON.stringify([receipt.threadId,m.content?.content?.text]))===receipt.digest);
    if(found){receipt.state='accepted';await this.store.transaction(()=>this.store.save());}
    return {...receipt,verifiedInHistory:!!found,hasOlder:!!result.page?.hasMore};
  }
  async handle(req,res){
    const url=new URL(req.url,'http://gateway.invalid'),route=url.pathname,method=req.method;
    if(method==='GET'&&route==='/health'){this.reply(res,200,{status:'ok',protocolVersion:1,capabilities:{moecastGateway:1}});return;}
    if(method==='POST'&&route==='/api/pair'){
      const input=await body(req);let paired;
      try{paired=await this.store.pair(input.code);}catch(e){this.limit();this.failures.push(this.now());throw e;}
      this.reply(res,200,paired);return;
    }
    if(method==='POST'&&route==='/api/auth'){
      const input=await body(req);let device;
      try{device=this.store.authenticate(input.accessToken);}catch(e){this.limit();this.failures.push(this.now());throw e;}
      const token=randomBytes(32).toString('base64url'),expiresAt=this.now()+15*60000;
      for(const [key,value]of this.tokens)if(value.expiresAt<=this.now())this.tokens.delete(key);
      const existing=[...this.tokens].filter(([,v])=>v.id===device.id);while(existing.length>=8)this.tokens.delete(existing.shift()[0]);
      if(this.tokens.size>2000)throw fault('TOO_MANY_SESSIONS',429);
      this.tokens.set(digest(token),{id:device.id,expiresAt});this.reply(res,200,{token,expiresAt,user:{id:device.id},device:this.store.publicDevice(device),hubId:this.store.data.hubId});return;
    }
    const device=this.authenticate(req);
    res.deviceId=device.id;
    if(method==='GET'&&route==='/api/device'){this.reply(res,200,{device:this.store.publicDevice(device),hubId:this.store.data.hubId});return;}
    if(route.startsWith('/api/assistant/')){
      if(!this.assistant)throw fault('ASSISTANT_UNAVAILABLE',503);
      if(route==='/api/assistant/config'&&method==='GET'){this.reply(res,200,await this.assistant.configuration(device.id));return;}
      if(route==='/api/assistant/config'&&method==='POST'){const input=await body(req);this.reply(res,200,await this.assistant.configure(device.id,input.model));return;}
      if(route==='/api/assistant/turn'&&method==='POST'){const input=await body(req);this.reply(res,200,await this.assistant.turn(device.id,input));return;}
      if(route==='/api/assistant/select'&&method==='POST'){const input=await body(req);this.reply(res,200,await this.assistant.select(device.id,input));return;}
      if(route==='/api/assistant/cancel'&&method==='POST'){const input=await body(req);this.reply(res,200,await this.assistant.cancel(device.id,input));return;}
    }
    if(method==='GET'&&route==='/api/machines'){
      const r=await this.hapi.json('/api/machines');this.store.require(device.id);
      this.reply(res,200,{machines:r.machines.filter(m=>m.id===this.directory.machineId).map(m=>({id:m.id,active:m.active,metadata:{displayName:m.metadata?.displayName||m.metadata?.host||'电脑'}}))});return;
    }
    if(method==='GET'&&route===`/api/machines/${this.directory.machineId}/agent-availability`){this.reply(res,200,{agents:[{agent:'codex',available:true}]});return;}
    if(method==='GET'&&route==='/api/threads'){
      const threads=await this.directory.list(device);this.store.require(device.id);
      const projects=[...new Set(threads.map(t=>t.project))].map(project=>({id:digest(project),path:project,name:threads.find(t=>t.project===project).projectName}));
      this.reply(res,200,{threads,projects});return;
    }
    const thread=route.match(/^\/api\/threads\/([0-9a-f-]{36})(?:\/(open|messages))?$/i);
    if(thread&&method==='GET'&&(!thread[2]||thread[2]==='messages')){
      const cursor=url.searchParams.get('cursor');if(cursor?.length>4096)throw fault('INVALID_REQUEST');
      const result=await this.directory.read(device,thread[1],cursor);this.store.require(device.id);this.reply(res,200,result);return;
    }
    if(thread&&method==='POST'&&thread[2]==='open'){
      this.store.require(device.id,'dispatch');await body(req);
      const result=await this.serial(thread[1],()=>this.directory.open(this.store.require(device.id,'dispatch'),thread[1],{allowBusy:true}));this.store.require(device.id,'dispatch');
      this.reply(res,200,{session:safeSession(result.session),target:result.target});return;
    }
    if(route==='/api/dispatch/prepare'&&method==='POST'){
      this.store.require(device.id,'dispatch');const input=await body(req),router=this.router(device);
      if(input.requestId){
        if(!validRequest(input.requestId))throw fault('INVALID_REQUEST');
        const previous=this.store.data.outbox[device.id+':'+input.requestId];
        if(previous){
          if(previous.requestDigest!==digest(selectionBinding(input)))throw fault('REQUEST_ID_CONFLICT',409);
          await this.directory.read(device,previous.threadId);this.reply(res,200,{kind:'submitted',ticket:input.requestId,receipt:structuredClone(previous)});return;
        }
      }
      const result=await router.prepare(input);
      if(result.kind==='ready'){const receipt=await router.select(result.ticket,result.candidates[0].id);this.reply(res,200,{...result,kind:'submitted',receipt});}
      else this.reply(res,200,result);return;
    }
    if(route==='/api/dispatch/select'&&method==='POST'){
      this.store.require(device.id,'dispatch');const input=await body(req);const result=await this.router(device).select(input.ticket,input.id);this.reply(res,200,result);return;
    }
    if(route==='/api/dispatch/cancel'&&method==='POST'){
      this.store.require(device.id,'dispatch');const input=await body(req);this.reply(res,200,this.router(device).cancel(input.ticket));return;
    }
    if(route==='/api/dispatch/receipt'&&method==='POST'){
      const input=await body(req);this.reply(res,200,await this.reconcile(device,input.requestId));return;
    }
    if(route==='/api/events'&&method==='GET'){
      const id=url.searchParams.get('sessionId');if(!isId(id))throw fault('INVALID_REQUEST');await this.directory.resolveSession(device,id);
      this.store.require(device.id);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
      const streams=this.streams.get(device.id)??new Set();if(streams.size>=4){res.end();return;}streams.add(res);this.streams.set(device.id,streams);
      let serial=0;
      const tick=()=>{try{this.authenticate(req);res.write(`id: ${++serial}\ndata: ${JSON.stringify({type:'session-updated',sessionId:id})}\n\n`);}catch{res.end();}};
      tick();const timer=setInterval(tick,2500);res.on('close',()=>{clearInterval(timer);streams.delete(res);});return;
    }
    const sessionRoute=route.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(messages|resume|abort))?$/i);
    if(sessionRoute){
      const id=sessionRoute[1],action=sessionRoute[2];const {session,target}=await this.directory.resolveSession(device,id);
      this.store.require(device.id);
      if(method==='GET'&&!action){this.reply(res,200,{session:safeSession(session)});return;}
      if(method==='GET'&&action==='messages'){
        if([...url.searchParams.keys()].some(k=>k!=='limit')||url.searchParams.get('limit')&&url.searchParams.get('limit')!=='200')throw fault('INVALID_REQUEST');
        const result=await this.hapi.json(`/api/sessions/${id}/messages?limit=200`);this.store.require(device.id);
        const rows=projectMessages([...result.messages].sort((a,b)=>(a.seq??0)-(b.seq??0)));
        const messages=rows.map((m,index)=>({id:m.id,seq:index,createdAt:0,localId:result.messages.find(r=>r.id===m.id)?.localId,content:m.role==='user'?{role:'user',content:{type:'text',text:m.text}}:{role:'agent',content:{type:'codex',data:{type:'message',message:m.text}}}}));
        this.reply(res,200,{messages,page:{hasMore:!!result.page?.hasMore}});return;
      }
      if(method==='POST'&&action==='messages'){
        const input=await body(req);this.store.require(device.id,'dispatch');
        const receipt=await this.dispatch(device.id,target.id,input.text,input.localId);
        this.reply(res,receipt.state==='accepted'?200:502,{ok:receipt.state==='accepted',receipt});return;
      }
      if(method==='POST'&&action==='resume'){
        this.store.require(device.id,'dispatch');const input=await body(req);
        if(Object.keys(input).some(k=>k!=='permissionMode')||input.permissionMode!=='read-only')throw fault('ACCESS_DENIED',403);
        const r=await this.serial(target.id,()=>this.directory.open(this.store.require(device.id,'dispatch'),target.id));
        this.reply(res,200,{type:'success',sessionId:r.session.id});return;
      }
      if(method==='POST'&&action==='abort'){
        this.store.require(device.id,'dispatch');const input=await body(req);if(Object.keys(input).length)throw fault('INVALID_REQUEST');
        const r=await this.hapi.json(`/api/sessions/${id}/abort`,'POST',{});this.reply(res,200,{ok:r.ok===true});return;
      }
    }
    // No catch-all proxy: owner settings, credentials, files, spawn, shell, models,
    // approval and arbitrary upstream routes cannot be reached by device tokens.
    throw fault('ACCESS_DENIED',403);
  }
  async listen(port=3317){await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});return this.server.address().port;}
  async admin(socket){
    try{await fs.unlink(socket);}catch(e){if(e.code!=='ENOENT')throw e;}
    this.adminServer=net.createServer(conn=>{let input='';conn.setTimeout(5000,()=>conn.destroy());conn.on('data',chunk=>{
      input+=chunk;if(input.length>32768){conn.destroy();return;}if(!input.includes('\n'))return;conn.pause();
      (async()=>{let result;const request=JSON.parse(input.split('\n')[0]);
        if(request.action==='pair')result=await this.store.issuePairing(request);
        else if(request.action==='revoke')result=await this.store.revoke(request.id);
        else if(request.action==='devices')result=this.store.list();
        else throw fault('INVALID_ADMIN_ACTION');conn.end(JSON.stringify({result})+'\n');
      })().catch(e=>conn.end(JSON.stringify({error:e.status?e.message:'ADMIN_FAILED'})+'\n'));
    });});
    await new Promise((resolve,reject)=>{this.adminServer.once('error',reject);this.adminServer.listen(socket,resolve);});await fs.chmod(socket,0o600);
  }
  async close(){for(const set of this.streams.values())for(const res of set)res.end();this.server.closeAllConnections();await new Promise(r=>this.server.close(r));if(this.adminServer)await new Promise(r=>this.adminServer.close(r));}
}
export async function adminRequest(socket,args){return new Promise((resolve,reject)=>{
  const conn=net.connect(socket);let result='';conn.setTimeout(10000,()=>conn.destroy(Error('ADMIN_TIMEOUT')));conn.on('connect',()=>conn.write(JSON.stringify(args)+'\n'));conn.on('data',chunk=>{result+=chunk;});conn.on('error',reject);conn.on('end',()=>{try{const data=JSON.parse(result);if(data.error)reject(fault(data.error));else resolve(data.result);}catch(e){reject(e);}});
});}
