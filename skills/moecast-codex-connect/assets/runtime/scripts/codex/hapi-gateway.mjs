import {SleepAssistant} from './hapi-sleep.mjs';
import {weatherTurn} from './hapi-weather.mjs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {DeviceStore,digest,fault,isId} from './hapi-device-store.mjs';
import {ArtifactDelivery} from './hapi-artifacts.mjs';
import {FrontdeskHistory} from './hapi-frontdesk-history.mjs';
const validRequest=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
const capabilities={moecastGateway:1,artifactDelivery:1,frontdeskHistory:1,frontdeskHistoryClear:1,sleepCompanion:1,weatherQuestions:1};
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
  constructor({store,directory,assistant,now=Date.now}){
    this.assistant=assistant;this.store=store;this.directory=directory;this.now=now;this.tokens=new Map();this.streams=new Map();this.failures=[];
    this.artifacts=new ArtifactDelivery({store,directory,now});this.frontdeskHistory=new FrontdeskHistory({store,now});
    this.sleepAssistant=new SleepAssistant({store,assistant:()=>this.assistant});
    store.listeners.add(id=>{for(const [key,v]of this.tokens)if(v.id===id)this.tokens.delete(key);for(const res of this.streams.get(id)??[])res.end();this.streams.delete(id);});
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
  async selection(device){
    const fixed=this.assistant?.preferences(device.id).frontdeskThreadId;if(!fixed)return null;
    const {target}=await this.directory.readNative(device,fixed);return {sessionId:fixed,threadId:fixed,machineId:target.machineId,directory:target.project};
  }
  async connectedSession(device,id){
    const fixed=await this.assistant.binding(device.id);
    if(id!==fixed)throw fault('ACCESS_DENIED',403);
    await this.assistant.desktopInbox(fixed).available();
    const history=await this.directory.readNative(device,fixed);
    const target=history.target;
    return {target:{...target,sessionId:fixed},session:{id:fixed,nativeDesktop:true,active:true,thinking:history.turns?.some(t=>t.status==='inProgress')??false,metadata:{path:target.project,machineId:target.machineId,codexSessionId:fixed,name:target.label},agentState:{requests:{}}}};
  }
  async handle(req,res){
    const url=new URL(req.url,'http://gateway.invalid'),route=url.pathname,method=req.method;
    if(method==='GET'&&route==='/health'){this.reply(res,200,{status:'ok',protocolVersion:1,capabilities});return;}
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
    if(method==='GET'&&route==='/api/device'){this.reply(res,200,{device:this.store.publicDevice(device),hubId:this.store.data.hubId,capabilities,selection:await this.selection(device)});return;}
    if(route==='/api/weather/turn'&&method==='POST'){const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});this.reply(res,200,await weatherTurn(this,device.id,await body(req),abort.signal));return;}
    if(route==='/api/sleep/turn'&&method==='POST'){const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});this.reply(res,200,await this.sleepAssistant.turn(device.id,await body(req),abort.signal));return;}
    if(route.startsWith('/api/tasks/'))throw fault('FEATURE_UNAVAILABLE',410);
    if(route.startsWith('/api/artifacts/')&&url.search)throw fault('INVALID_ARTIFACT_REQUEST');
    if(route==='/api/artifacts/list'&&method==='POST'){
      const input=await body(req);if(Object.keys(input).some(k=>!['requestId','name'].includes(k))||typeof input.requestId!=='string'||!validRequest(input.requestId)||input.name!==undefined&&(typeof input.name!=='string'||!input.name||input.name.length>240||/[\x00-\x1f\x7f/\\]/.test(input.name)))throw fault('INVALID_ARTIFACT_REQUEST');
      if(this.assistant?.request(device.id,input.requestId)?.transport==='desktop_native')await this.assistant.reconcile(device.id,input.requestId);
      this.reply(res,200,await this.artifacts.list(device.id,input.requestId,input.name));return;
    }
    if(route==='/api/artifacts/chunk'&&method==='POST'){
      this.reply(res,200,await this.artifacts.chunk(device.id,await body(req)));return;
    }
    if(route==='/api/assistant/history/clear'&&method==='POST'){
      const input=await body(req);if(Object.keys(input).length)throw fault('INVALID_HISTORY_REQUEST');
      this.reply(res,200,await this.frontdeskHistory.clear(device.id));return;
    }
    if(route==='/api/assistant/history'&&method==='POST'){
      const input=await body(req);if(Object.keys(input).some(k=>!['beforeSequence','limit'].includes(k)))throw fault('INVALID_HISTORY_CURSOR');
      await this.frontdeskHistory.reconcile(device.id,input,(requestId)=>this.assistant.reconcile(device.id,requestId));this.reply(res,200,this.frontdeskHistory.list(device.id,input));return;
    }
    if(route.startsWith('/api/assistant/')){
      if(!this.assistant)throw fault('ASSISTANT_UNAVAILABLE',503);
      if(route==='/api/assistant/config'&&method==='GET'){this.reply(res,200,await this.assistant.configuration(device.id));return;}
      if(route==='/api/assistant/config'&&method==='POST'){const input=await body(req);this.reply(res,200,await this.assistant.configure(device.id,input.model));return;}
      if(route==='/api/assistant/turn'&&method==='POST'){this.store.require(device.id,'dispatch');const input=await body(req);this.reply(res,200,await this.frontdeskHistory.run(device.id,'turn',input,()=>this.assistant.turn(device.id,input)));return;}
      if(route==='/api/assistant/select'&&method==='POST'){this.reply(res,410,{error:'FEATURE_UNAVAILABLE'});return;}
      if(route==='/api/assistant/cancel'&&method==='POST'){this.reply(res,410,{error:'FEATURE_UNAVAILABLE'});return;}
    }
    if(method==='GET'&&route==='/api/machines'){
      // Native desktop delivery does not use the Runner to execute messages.
      // Its heartbeat must not veto a live, authorized Codex desktop connection.
      if(!this.assistant)throw fault('ASSISTANT_UNAVAILABLE',503);
      const fixed=await this.assistant.binding(device.id);
      await this.directory.authorization(device,fixed);
      await this.assistant.desktopInbox(fixed).available();
      this.store.require(device.id);
      this.reply(res,200,{machines:[{id:this.directory.machineId,active:true,metadata:{displayName:'电脑 Codex'}}]});return;
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
      this.store.require(device.id,'dispatch');await body(req);const fixed=await this.assistant.binding(device.id,thread[1]);
      await this.assistant.desktopInbox(fixed).open();const result=await this.connectedSession(device,fixed);this.reply(res,200,{session:safeSession(result.session),target:result.target});return;
    }
    if(route.startsWith('/api/dispatch/')){this.reply(res,410,{error:'FEATURE_UNAVAILABLE'});return;}
    if(route==='/api/events'&&method==='GET'){
      const id=url.searchParams.get('sessionId');if(!isId(id))throw fault('INVALID_REQUEST');
      let closed=false,timer,streams;
      const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);streams?.delete(res);if(streams?.size===0&&this.streams.get(device.id)===streams)this.streams.delete(device.id);};
      // Observe disconnects before any desktop read can yield. A response whose
      // close event already fired must never acquire a slot or heartbeat timer.
      res.once('close',cleanup);
      try{
        await this.connectedSession(device,id);
        if(closed||res.destroyed||res.writableEnded){cleanup();return;}
        this.store.require(device.id);
        streams=this.streams.get(device.id)??new Set();
        for(const stream of streams)if(stream.destroyed||stream.writableEnded)streams.delete(stream);
        if(streams.size>=4)throw fault('TOO_MANY_STREAMS',429);
        streams.add(res);this.streams.set(device.id,streams);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
        let serial=0;
        const tick=()=>{if(closed)return;if(res.destroyed||res.writableEnded){cleanup();return;}try{this.authenticate(req);res.write(`id: ${++serial}\ndata: ${JSON.stringify({type:'session-updated',sessionId:id})}\n\n`);}catch{cleanup();res.end();}};
        timer=setInterval(tick,2500);tick();
      }catch(error){cleanup();if(!res.destroyed)throw error;}
      return;
    }
    const sessionRoute=route.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(messages|resume|abort))?$/i);
    if(sessionRoute){
      const id=sessionRoute[1],action=sessionRoute[2];const {session,target}=await this.connectedSession(device,id);
      this.store.require(device.id);
      if(method==='GET'&&!action){this.reply(res,200,{session:safeSession(session)});return;}
      if(method==='GET'&&action==='messages'){
          if([...url.searchParams.keys()].some(key=>!['cursor','limit'].includes(key))||url.searchParams.getAll('cursor').length>1||url.searchParams.getAll('limit').length>1||url.searchParams.has('limit')&&url.searchParams.get('limit')!=='200'||url.searchParams.has('cursor')&&!url.searchParams.get('cursor'))throw fault('INVALID_CURSOR');
          let cursor;const value=url.searchParams.get('cursor');
          if(value){try{if(value.length>8192)throw Error();const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(parsed.sessionId!==id||typeof parsed.nativeCursor!=='string'||Object.keys(parsed).some(k=>!['sessionId','nativeCursor'].includes(k)))throw Error();cursor=parsed.nativeCursor;}catch{throw fault('INVALID_CURSOR');}}
          const r=await this.directory.read(device,target.id,cursor);
          const messages=r.messages.filter(m=>m.role==='user'||m.phase==='final_answer').map(m=>({id:m.id,seq:m.seq,createdAt:m.createdAt,localId:m.clientId,content:m.role==='user'?{role:'user',content:{type:'text',text:m.text}}:{role:'agent',content:{type:'codex',data:{type:'message',id:m.id,message:m.text}}}}));
          this.reply(res,200,{messages,page:{hasMore:!!r.hasOlder,nextCursor:r.nextCursor?Buffer.from(JSON.stringify({sessionId:id,nativeCursor:r.nextCursor})).toString('base64url'):null},serverTime:this.now()});return;
      }
      if(method==='POST'&&action==='messages'){
        const input=await body(req);this.store.require(device.id,'dispatch');
        const fixed=this.assistant?.preferences(device.id).frontdeskThreadId;if(fixed&&fixed!==target.id)throw fault('ACCESS_DENIED',403);
        if(typeof input.text!=='string'||!input.text.trim()||!isId(input.localId))throw fault('INVALID_REQUEST');
        if(!fixed||fixed!==target.id)throw fault('ACCESS_DENIED',403);
        const result=await this.assistant.turn(device.id,{text:input.text,requestId:input.localId,frontdeskThreadId:fixed});this.reply(res,200,{ok:result.kind==='reply',result});return;
      }
      if(method==='POST'&&action==='resume'){
        this.store.require(device.id,'dispatch');const input=await body(req);if(Object.keys(input).length)throw fault('ACCESS_DENIED',403);
        const fixed=await this.assistant.binding(device.id,target.id);await this.assistant.desktopInbox(fixed).open();this.reply(res,200,{type:'success',sessionId:fixed});return;
      }
      if(method==='POST'&&action==='abort')throw fault('FEATURE_UNAVAILABLE',410);
    }
    // No catch-all proxy: owner settings, credentials, files, spawn, shell, models,
    // approval and arbitrary upstream routes cannot be reached by device tokens.
    throw fault('ACCESS_DENIED',403);
  }
  async listen(port=3317){await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});return this.server.address().port;}
  async admin(socket){
    const endpoint=typeof socket==='string'?socket:socket.path;
    // Windows pipe DACLs differ from Unix socket modes: also require an
    // installation-local capability stored under the current user's private ACL.
    const adminToken=typeof socket==='string'?null:randomBytes(32).toString('hex');
    if(adminToken)await fs.writeFile(socket.tokenFile,adminToken,{mode:0o600});
    else try{await fs.unlink(endpoint);}catch(e){if(e.code!=='ENOENT')throw e;}
    this.adminServer=net.createServer(conn=>{let input='';conn.setTimeout(5000,()=>conn.destroy());conn.on('data',chunk=>{
      input+=chunk;if(input.length>32768){conn.destroy();return;}if(!input.includes('\n'))return;conn.pause();
      (async()=>{let result;const request=JSON.parse(input.split('\n')[0]);
        if(adminToken&&(typeof request.adminToken!=='string'||digest(request.adminToken)!==digest(adminToken)))throw fault('ADMIN_ACCESS_DENIED',403);
        conn.setTimeout(request.action==='deliver'?180000:10000);
        if(request.action==='pair'){const threadId=request.frontdeskThreadId;if(!isId(threadId))throw fault('FIXED_FRONTDESK_REQUIRED',409);const t=await this.directory.codex.metadata(threadId);if(t?.id!==threadId||!path.isAbsolute(t.cwd))throw fault('INVALID_FRONTDESK_BINDING');await this.assistant.desktopInbox(threadId).available();await this.directory.codex.rpc('thread/queue/list',{threadId,limit:1});result=await this.store.issuePairing({...request,selection:{sessionId:threadId,threadId,machineId:this.directory.machineId,directory:t.cwd}});}
        else if(request.action==='revoke')result=await this.store.revoke(request.id);
        else if(request.action==='devices')result=this.store.list();
        else if(request.action==='check'){
          const bound=Object.values(this.store.data.devices).filter(d=>!d.revokedAt&&d.assistant?.frontdeskThreadId);
          const checked=new Set();
          for(const device of bound){
            const fixed=device.assistant.frontdeskThreadId;
            await this.directory.authorization(this.store.require(device.id),fixed);
            if(checked.has(fixed))continue;
            await this.assistant.desktopInbox(fixed).available();
            await this.directory.codex.rpc('thread/queue/list',{threadId:fixed,limit:1});
            checked.add(fixed);
          }
          result={ready:true,bindingChecked:bound.length>0,boundDevices:bound.length,machineId:this.directory.machineId};
        }
        else if(request.action==='deliver'){if(this.assistant?.request(request.deviceId,request.requestId)?.transport==='desktop_native')await this.assistant.reconcile(request.deviceId,request.requestId);result=await this.artifacts.publish(request);}
        else throw fault('INVALID_ADMIN_ACTION');conn.end(JSON.stringify({result})+'\n');
      })().catch(e=>conn.end(JSON.stringify({error:e.status?e.message:'ADMIN_FAILED'})+'\n'));
    });});
    await new Promise((resolve,reject)=>{this.adminServer.once('error',reject);this.adminServer.listen(endpoint,resolve);});if(!adminToken)await fs.chmod(endpoint,0o600);
  }
  async close(){for(const set of this.streams.values())for(const res of set)res.end();this.server.closeAllConnections();await new Promise(r=>this.server.close(r));if(this.adminServer)await new Promise(r=>this.adminServer.close(r));}
}
export async function adminRequest(socket,args){
 const endpoint=typeof socket==='string'?socket:socket.path;
 const payload=typeof socket==='string'?args:{...args,adminToken:await fs.readFile(socket.tokenFile,'utf8')};
 return new Promise((resolve,reject)=>{
  const conn=net.connect(endpoint);let result='';conn.setTimeout(args.action==='deliver'?180000:10000,()=>conn.destroy(Error('ADMIN_TIMEOUT')));conn.on('connect',()=>conn.write(JSON.stringify(payload)+'\n'));conn.on('data',chunk=>{result+=chunk;});conn.on('error',reject);conn.on('end',()=>{try{const data=JSON.parse(result);if(data.error)reject(fault(data.error));else resolve(data.result);}catch(e){reject(e);}});
});}
