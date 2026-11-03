// Shared public HAPI protocol. The platform supplies storage, hashing and transport.
(function (root) {
  const factory = ({ fs, path, hash, randomUUID, MessageSync = root.MoeCastMessageSync?.MessageSync }) => {
const fail = code => new Error(`HAPI_${code}`);
const transportFailure = error => ['HAPI_BACKGROUND','HAPI_RETRY_LATER','HAPI_BUSY'].includes(error?.message) ? new Error(error.message) : fail('NETWORK_ERROR');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
function hubOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw fail('INVALID_URL');
  return url.origin;
}

/** Deliberately a text-only Codex projection. Never expose reasoning/tool arguments as speech. */
function projectMessages(messages) {
  const rows = new Map();
  for (const message of messages) {
    if (!object(message) || typeof message.id !== 'string' || !/^[a-zA-Z0-9_:-]{1,512}$/.test(message.id)) continue;
    const raw = message.content;
    const envelope = [raw, raw?.message, raw?.data?.message, raw?.payload?.message]
      .find(value => object(value) && typeof value.role === 'string' && 'content' in value);
    if (!envelope) continue;
    const payload = envelope.content;
    let text, role, streamId;
    if (envelope.role === 'user') {
      text = typeof payload === 'string' ? payload : payload?.type === 'text' ? payload.text : undefined;
      role = 'user';
    } else if (envelope.role === 'agent' && payload?.type === 'codex' && payload.data?.type === 'message') {
      text = payload.data.message; role = 'agent'; streamId = payload.data.id;
    } else if (envelope.role === 'agent' && ['codex', 'event'].includes(payload?.type) && payload.data?.type === 'error') {
      text = 'Agent reported an error. Check Codex authentication, quota and network.'; role = 'error';
    }
    if (typeof text !== 'string' || !text) continue;
    // Snapshot messages with the same stream id replace previous snapshots, never concatenate them.
    const key = role === 'agent' && typeof streamId === 'string' && /^[a-zA-Z0-9_:-]{1,500}$/.test(streamId) ? `stream:${streamId}` : message.id;
    const previous=rows.get(key), timestamp=message.invokedAt??message.createdAt, at=Number.isFinite(timestamp)&&timestamp>0?timestamp:0;
    rows.set(key, { id: key, role, text, createdAt:previous?.createdAt>0&&at>0?Math.min(previous.createdAt,at):previous?.createdAt||at, seq:message.seq??0, sourceId:message.id });
  }
  return [...rows.values()];
}

async function* sseFrames(body, signal) {
  const reader = body.getReader(), decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw fail('PROTOCOL_ERROR');
      // Normalize at frame boundaries, including a CRLF split across chunks.
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const lines = block.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch { throw fail('PROTOCOL_ERROR'); }
        const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
        yield { event, id };
      }
    }
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Experimental desktop client of the PUBLIC HAPI REST/SSE API; never calls /cli. */
class Hapi {
  constructor(root, emit = () => {}, options = {}) {
    this.optionsOrigin = options.origin || hubOrigin; this.now = options.now || Date.now; this.syncTasks = new Map(); this.storageTasks = new Map(); this.root = root; this.emit = emit; this.fetch = options.fetch || globalThis.fetch;
    this.file = path.join(root, 'hapi-lab-sessions.json');
    this.directory = path.join(root, 'hapi-chat-workspace');
    this.state = { connected: false, streaming: false, machines: [], messages: [], requests: [], directory: this.directory };
    this.epoch = 0; this.records = {}; this.locked = false;
  }
  status() { return structuredClone(this.state); }
  patch(value) { this.state = { ...this.state, ...value }; this.emit(this.status()); }
  async exclusive(action) {
    if (this.locked) throw fail('BUSY');
    this.locked = true;
    try { return await action(); }
    catch (error) { throw /^HAPI_[A-Z_]+$/.test(error?.message) ? error : fail('REQUEST_FAILED'); }
    finally { this.locked = false; }
  }
  async raw(route, method = 'GET', body, authenticated = true, streamSignal, requestSignal) {
    const token = this.jwt;
    const timeout = () => AbortSignal.timeout(route.endsWith('/assistant/turn') ? 150000 : ['/resume','/assistant/turn','/weather/turn','/sleep/turn'].some(suffix=>route.endsWith(suffix)) || /^\/api\/threads\/[^/]+\/open$/.test(route) ? 90000 : method === 'GET' && /^\/api\/(threads|sessions)(?:[/?]|$)/.test(route) ? 60000 : 15000);
    let response;
    try {
      response = await this.fetch(`${this.origin}${route}`, { method, redirect: 'error',
        headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(streamSignal ? { Accept: 'text/event-stream', 'Accept-Encoding': 'identity' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: streamSignal || (requestSignal ? AbortSignal.any([requestSignal,timeout()]) : timeout()) });
    } catch (error) { throw transportFailure(error); }
    if (response.status === 401 && authenticated) {
      if (this.jwt === token) await this.authenticate(requestSignal || streamSignal);
      try {
        response = await this.fetch(`${this.origin}${route}`, { method, redirect: 'error',
          headers: { Authorization: `Bearer ${this.jwt}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(streamSignal ? { Accept: 'text/event-stream', 'Accept-Encoding': 'identity' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: streamSignal || (requestSignal ? AbortSignal.any([requestSignal,timeout()]) : timeout()) });
      } catch (error) { throw transportFailure(error); }
    }
    if (!response.ok) {
      // Recognize only the explicit ownership conflict, never expose upstream text.
      if(method==='POST'&&/^\/api\/sessions\/[^/]+\/resume$/.test(route)&&response.status>=500){
        let detail;try{detail=await response.clone().json();}catch{}
        const message=typeof detail?.error==='string'?detail.error:'';
        if(/already has an active writer|thread-store conflict/i.test(message))throw fail('TARGET_IN_USE');
      }
      // Safe artifact errors carry expiry/range/corruption information for the UI;
      // never surface arbitrary backend text, paths or exception messages.
      if(route.startsWith('/api/artifacts/')){
        let detail;try{detail=await response.clone().json();}catch{}
        if(/^(ARTIFACT|DELIVERY)_[A-Z_]+$/.test(detail?.error??''))throw fail(detail.error);
      }
      throw fail(response.status === 401 ? 'PAIRING_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TEMPORARY_UNAVAILABLE' : 'REQUEST_FAILED');
    }
    return response;
  }
  async json(route, method = 'GET', body, authenticated = true, signal) {
    const response = await this.raw(route, method, body, authenticated, undefined, signal);
    let value;
    try { value = await response.json(); } catch { throw fail('PROTOCOL_ERROR'); }
    if (!object(value)) throw fail('PROTOCOL_ERROR');
    if (value.success === false || value.type === 'error') throw fail('AGENT_UNAVAILABLE');
    return value;
  }
  async authenticate(signal) {
    if (!this.refreshing) this.refreshing = (async () => {
      const epoch = this.epoch;
      const result = await this.json('/api/auth', 'POST', { accessToken: this.accessToken }, false, signal);
      if (epoch !== this.epoch) throw fail('DISCONNECTED');
      if (typeof result.token !== 'string' || !result.token) throw fail('PROTOCOL_ERROR');
      this.jwt = result.token;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  connect(args, signal) { return this.exclusive(async () => {
    const origin = this.optionsOrigin(args.url);
    if (typeof args.token !== 'string' || !args.token.trim() || args.token.length > 4096) throw fail('PAIRING_REQUIRED');
    this.disconnect();
    const epoch = this.epoch;
    this.origin = origin; this.accessToken = args.token.trim();
    const health = await this.json('/health', 'GET', undefined, false, signal);
    if (health.status !== 'ok' || health.protocolVersion !== 1) throw fail('PROTOCOL_MISMATCH');
    await this.authenticate(signal);
    const result = await this.json('/api/machines','GET',undefined,true,signal);
    if (epoch !== this.epoch) throw fail('DISCONNECTED');
    if (!Array.isArray(result.machines)) throw fail('PROTOCOL_ERROR');
    this.identity = await hash(`${origin}\n${this.accessToken}`);
    try { this.records = JSON.parse(await fs.readFile(this.file, 'utf8')); if (!object(this.records)) throw fail('STORAGE_ERROR'); }
    catch (error) { if (error.code === 'ENOENT') this.records = {}; else throw fail('STORAGE_ERROR'); }
    await fs.mkdir(this.directory, { recursive: true });
    if (epoch !== this.epoch) throw fail('DISCONNECTED');
    this.patch({ connected: true, gateway: health.capabilities?.moecastGateway === 1, url: origin, error: undefined, machines: result.machines.filter(machine => identifier(machine.id) && machine.active !== false).map(machine => ({ id: machine.id, name: machine.metadata?.displayName || machine.metadata?.host || machine.id })) });
    return this.status();
  }); }
  async save() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(this.file + '.new', JSON.stringify(this.records), { mode: 0o600 });
    await fs.rename(this.file + '.new', this.file);
  }
  attachThread(args) { return this.exclusive(async () => {
    if (!this.state.connected || !this.state.gateway || !identifier(args.threadId)) throw fail('INVALID_REQUEST');
    if (this.state.thinking || this.state.requests.length) throw fail('BUSY');
    const result = await this.json(`/api/threads/${encodeURIComponent(args.threadId)}/open`, 'POST', {});
    const session = result.session, metadata = session?.metadata;
    if (!identifier(session?.id) || !identifier(metadata?.machineId) || typeof metadata?.path !== 'string' ||
        (metadata.codexThreadId || metadata.codexSessionId) !== args.threadId) throw fail('SESSION_MISMATCH');
    this.stopStream(); const epoch = this.epoch;
    const key = await hash(JSON.stringify([this.identity, metadata.machineId, metadata.path]));
    this.records[key] = { sessionId: session.id }; await this.save();
    this.patch({ sessionId: session.id, machineId: metadata.machineId, directory: metadata.path, streaming: false, messages: [], updates: [], sync: undefined, requests: [], thinking: false, error: undefined });
    await this.refresh(epoch); this.streamTask = this.stream(epoch); return this.status();
  }); }
  openSession(args) { return this.exclusive(async () => {
    if (!this.state.connected) throw fail('PAIRING_REQUIRED');
    if (this.state.sessionId && (this.state.thinking || this.state.requests.length)) throw fail('BUSY');
    if (!identifier(args.machineId) || !this.state.machines.some(machine => machine.id === args.machineId) ||
        typeof args.directory !== 'string' || !args.directory.trim() || args.directory.length > 4096) throw fail('INVALID_REQUEST');
    const availability = await this.json(`/api/machines/${encodeURIComponent(args.machineId)}/agent-availability`);
    if (!availability.agents?.some(agent => agent.agent === 'codex' && agent.available === true)) throw fail('AGENT_UNAVAILABLE');
    const key = await hash(JSON.stringify([this.identity, args.machineId, args.directory]));
    this.stopStream();
    const epoch = this.epoch;
    const id = args.sessionId || this.records[key]?.sessionId;
    if (!identifier(id)) throw fail('NO_SESSION');
    if (args.fresh) throw fail('FEATURE_UNAVAILABLE');
    const { session } = await this.json(`/api/sessions/${encodeURIComponent(id)}`);
    if (!session || session.id !== id || session.metadata?.path !== args.directory || session.metadata?.machineId !== args.machineId || args.threadId && (session.metadata?.codexThreadId || session.metadata?.codexSessionId) !== args.threadId) throw fail('SESSION_MISMATCH');
    if (!session.active) throw fail('AGENT_UNAVAILABLE');
    // The authenticated gateway verifies the saved fixed desktop identity.
    if (epoch !== this.epoch) throw fail('DISCONNECTED');
    this.records[key] = { sessionId: id };
    await this.save();
    if (epoch !== this.epoch) throw fail('DISCONNECTED');
    this.patch({ sessionId: id, machineId: args.machineId, directory: args.directory, streaming: false, messages: [], updates: [], sync: undefined, requests: [], thinking: false, error: undefined });
    await this.refresh();
    this.streamTask = this.stream(epoch);
    return this.status();
  }); }
  async refresh(epoch = this.epoch) {
    const key=JSON.stringify([epoch,this.state.sessionId]);
    if(this.syncTasks.has(key))return this.syncTasks.get(key);
    const task=this.refreshSnapshot(epoch);this.syncTasks.set(key,task);
    try{return await task;}finally{if(this.syncTasks.get(key)===task)this.syncTasks.delete(key);}
  }
  async withStoredSync(file,action) {
    const previous=this.storageTasks.get(file);
    const task=(async()=>{await previous?.catch(()=>{});return action();})();
    this.storageTasks.set(file,task);
    try{return await task;}finally{if(this.storageTasks.get(file)===task)this.storageTasks.delete(file);}
  }
  async syncFile(threadId) {return path.join(this.root,'codex-messages-'+await hash(JSON.stringify([this.identity,threadId]))+'.json');}
  async loadSync(file) {
    try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw fail('STORAGE_ERROR');}
  }
  async saveSync(file,record) {
    try{await fs.mkdir(this.root,{recursive:true});await fs.writeFile(file+'.new',JSON.stringify(record),{mode:0o600});await fs.rename(file+'.new',file);}catch{throw fail('STORAGE_ERROR');}
  }
  async acknowledgeUpdates({ids}) {
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw fail('INVALID_REQUEST');
    await this.refresh();
    const epoch=this.epoch,thread=this.state.threadId;
    if(!thread||!this.state.gateway)throw fail('INVALID_REQUEST');
    const file=await this.syncFile(thread);
    return this.withStoredSync(file,async()=>{
      const record=await this.loadSync(file);
      if(!record||epoch!==this.epoch||thread!==this.state.threadId)return this.status();
      record.notices=record.notices.filter(id=>!ids.includes(id));await this.saveSync(file,record);
      if(epoch===this.epoch&&thread===this.state.threadId)this.patch({updates:(this.state.updates||[]).filter(row=>!ids.includes(row.id))});return this.status();
    });
  }
  async refreshSnapshot(epoch = this.epoch, signal) {
    const id = this.state.sessionId;
    if (!id) return;
    const { session } = await this.json(`/api/sessions/${encodeURIComponent(id)}`,'GET',undefined,true,signal);
    const result = await this.json(`/api/sessions/${encodeURIComponent(id)}/messages?limit=200`,'GET',undefined,true,signal);
    if (epoch !== this.epoch || id !== this.state.sessionId || signal?.aborted) return;
    if (!session || session.id !== id || !Array.isArray(result.messages)) throw fail('PROTOCOL_ERROR');
    const threadId=session.metadata?.codexThreadId || session.metadata?.codexSessionId;
    let messages=projectMessages([...result.messages].sort((a,b)=>(a.seq??0)-(b.seq??0))),sync,updates=[];
    if(this.state.gateway&&threadId&&MessageSync){
      const file=await this.syncFile(threadId),valid=()=>epoch===this.epoch&&id===this.state.sessionId&&!signal?.aborted;
      const decode=value=>{if(!Array.isArray(value.messages))throw fail('PROTOCOL_ERROR');return {...value,messages:projectMessages(value.messages)};};
      const reader=new MessageSync({load:()=>this.loadSync(file),save:record=>this.saveSync(file,record),now:this.now,
        read:async cursor=>decode(await this.json(`/api/sessions/${encodeURIComponent(id)}/messages?limit=200&cursor=${encodeURIComponent(cursor)}`,'GET',undefined,true,signal))});
      const record=await this.withStoredSync(file,()=>valid()?reader.run(decode(result),valid):null);if(!record||!valid())return;
      messages=record.messages;sync={complete:record.complete,pendingPages:record.cursors.length,warning:record.warning,observedAt:result.serverTime??null};
      updates=record.notices.map(key=>messages.find(row=>row.id===key)).filter(Boolean).map(row=>({...row,threadId}));
    }
    if(epoch!==this.epoch||id!==this.state.sessionId)return;
    const requests = object(session.agentState?.requests) ? Object.entries(session.agentState.requests).filter(([requestId]) => identifier(requestId)).map(([requestId, request]) => ({ id: requestId, tool: String(request?.tool || 'Tool') })) : [];
    this.patch({ active: !!session.active, thinking: !!session.thinking, threadId,
      model: session.model, permissionMode: session.permissionMode, requests,
      messages, sync, updates, hasOlder:sync?!sync.complete:!!result.page?.hasMore });
  }

  async stream(epoch, options = {}) {
    let attempts = 0, notified = false;
    while (epoch === this.epoch && this.state.connected) {
      const controller = this.streamController = new AbortController();
      // Refresh even with a valid replay cursor. Full REST snapshots avoid stale patch resurrection.
      let timer = setTimeout(() => controller.abort(), 10000);
      try {
        const query = new URLSearchParams({ sessionId: this.state.sessionId, visibility: 'hidden' });
        if (this.cursor) query.set('lastEventId', this.cursor);
        const response = await this.raw(`/api/events?${query}`, 'GET', undefined, true, controller.signal);
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw fail('PROTOCOL_ERROR');
        for await (const { event, id } of sseFrames(response.body, controller.signal)) {
          clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000);
          if (epoch !== this.epoch) return;
          if (controller.signal.aborted) throw fail('NETWORK_ERROR');
          if(!object(event)||typeof event.type!=='string')throw fail('PROTOCOL_ERROR');
          if(!this.state.streaming)this.patch({ streaming: true, error: undefined }); attempts = 0;
          if(!notified){notified=true;options.opened?.();}
          if (event.type === 'connection-changed' || event.sessionId === this.state.sessionId) await this.refresh(epoch);
          // No-id heartbeats preserve cursor. Failed refresh leaves it unchanged for replay.
          if (id) this.cursor = id;
        }
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.patch({ streaming: false, error: /^HAPI_[A-Z_]+$/.test(error?.message) ? error.message : 'HAPI_NETWORK_ERROR' });
        if (['HAPI_PAIRING_REQUIRED','HAPI_ACCESS_DENIED','HAPI_BACKGROUND'].includes(error?.message)) { options.failed?.(error);return; }
        options.failed?.(error);
      } finally { clearTimeout(timer); controller.abort(); }
      if (epoch !== this.epoch) return;
      this.patch({ streaming: false });
      if(options.singleAttempt){if(!notified)options.failed?.(fail('NETWORK_ERROR'));return;}
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
      await new Promise(resolve => { this.retryResolve = resolve; this.retryTimer = setTimeout(resolve, delay); });
    }
  }
  send(args) { return this.exclusive(async () => {
    if (!this.state.connected || !this.state.sessionId) throw fail('NO_SESSION');
    if (!this.state.streaming || !this.state.active) throw fail('NETWORK_ERROR');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 32000) throw fail('INVALID_REQUEST');
    const localId = randomUUID();
    // Never auto-retry a network error: acceptance may have succeeded at the hub.
    const result = await this.json(`/api/sessions/${encodeURIComponent(this.state.sessionId)}/messages`, 'POST', { text: args.text, localId });
    if (result.ok !== true) throw fail('PROTOCOL_ERROR');
    return { accepted: true, localId }; // Acceptance is not a completed model answer.
  }); }
  abort() { return this.exclusive(async () => {
    if (!this.state.sessionId) throw fail('NO_SESSION');
    const result = await this.json(`/api/sessions/${encodeURIComponent(this.state.sessionId)}/abort`, 'POST', {});
    if (result.ok !== true) throw fail('PROTOCOL_ERROR');
    return { requested: true };
  }); }
  deny(args) { return this.exclusive(async () => {
    if (!this.state.sessionId || !identifier(args.requestId) || !this.state.requests.some(request => request.id === args.requestId)) throw fail('INVALID_REQUEST');
    const result = await this.json(`/api/sessions/${encodeURIComponent(this.state.sessionId)}/permissions/${encodeURIComponent(args.requestId)}/deny`, 'POST', { decision: 'denied' });
    if (result.ok !== true) throw fail('PROTOCOL_ERROR');
    await this.refresh(); return this.status();
  }); }
  stopStream() {
    ++this.epoch; this.streamController?.abort(); clearTimeout(this.retryTimer); this.retryResolve?.(); this.cursor = undefined;
    this.patch({ streaming: false });
  }
  // Network/lifecycle signals invalidate only the socket, never the conversation or sends.
  reconnect() {
    if (!this.state.connected || !this.state.sessionId) return;
    this.stopStream();
    this.streamTask = this.stream(this.epoch);
  }
  async reconnectOnce(signal) {
    if(!this.state.connected||!this.state.sessionId)throw fail('NO_SESSION');
    if(this.state.streaming)return this.status();
    this.stopStream();
    await new Promise((resolve,reject)=>{
      const cancel=()=>{this.streamController?.abort();reject(fail('NETWORK_ERROR'));};
      const done=callback=>value=>{signal?.removeEventListener('abort',cancel);callback(value);};
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted){cancel();return;}
      this.streamTask=this.stream(this.epoch,{singleAttempt:true,opened:done(resolve),failed:done(reject)});
    });return this.status();
  }
  disconnect() {
    this.stopStream(); this.jwt = undefined; this.accessToken = undefined;
    this.patch({ connected: false, gateway: false, streaming: false, url: undefined, hubId: undefined, deviceId: undefined, grants: undefined, capabilities: undefined, machineId: undefined, directory: this.directory, machines: [], messages: [], updates: [], sync: undefined, requests: [], sessionId: undefined, threadId: undefined, thinking: false, active: false, error: undefined });
  }
}

return { Hapi, hubOrigin, projectMessages, sseFrames };
};
if (typeof module === 'object' && module.exports) module.exports = factory;
else root.MoeCastHapiCore = factory;
})(globalThis);
