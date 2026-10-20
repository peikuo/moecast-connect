// Shared public HAPI protocol. The platform supplies storage, hashing and transport.
(function (root) {
  const factory = ({ fs, path, hash, randomUUID }) => {
const fail = code => new Error(`HAPI_${code}`);
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
    if (!object(message) || !identifier(message.id)) continue;
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
    const key = role === 'agent' && typeof streamId === 'string' ? `stream:${streamId}` : message.id;
    rows.set(key, { id: key, role, text: text.slice(0, 100000), createdAt: message.createdAt ?? 0 });
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
    this.optionsOrigin = options.origin || hubOrigin; this.root = root; this.emit = emit; this.fetch = options.fetch || globalThis.fetch;
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
  async raw(route, method = 'GET', body, authenticated = true, streamSignal) {
    const token = this.jwt;
    const timeout = () => AbortSignal.timeout(['/spawn','/resume','/codex/sync-session','/dispatch/prepare','/dispatch/select','/assistant/turn','/assistant/select'].some(suffix=>route.endsWith(suffix)) || /^\/api\/threads\/[^/]+\/open$/.test(route) ? 90000 : method === 'GET' && /^\/api\/(threads|sessions)(?:[/?]|$)/.test(route) ? 60000 : 15000);
    let response;
    try {
      response = await this.fetch(`${this.origin}${route}`, { method, redirect: 'error',
        headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(streamSignal ? { Accept: 'text/event-stream', 'Accept-Encoding': 'identity' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: streamSignal || timeout() });
    } catch { throw fail('NETWORK_ERROR'); }
    if (response.status === 401 && authenticated) {
      if (this.jwt === token) await this.authenticate();
      try {
        response = await this.fetch(`${this.origin}${route}`, { method, redirect: 'error',
          headers: { Authorization: `Bearer ${this.jwt}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(streamSignal ? { Accept: 'text/event-stream', 'Accept-Encoding': 'identity' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: streamSignal || timeout() });
      } catch { throw fail('NETWORK_ERROR'); }
    }
    if (!response.ok) throw fail(response.status === 401 ? 'PAIRING_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TEMPORARY_UNAVAILABLE' : 'REQUEST_FAILED');
    return response;
  }
  async json(route, method = 'GET', body, authenticated = true) {
    const response = await this.raw(route, method, body, authenticated);
    let value;
    try { value = await response.json(); } catch { throw fail('PROTOCOL_ERROR'); }
    if (!object(value)) throw fail('PROTOCOL_ERROR');
    if (value.success === false || value.type === 'error') throw fail('AGENT_UNAVAILABLE');
    return value;
  }
  async authenticate() {
    if (!this.refreshing) this.refreshing = (async () => {
      const epoch = this.epoch;
      const result = await this.json('/api/auth', 'POST', { accessToken: this.accessToken }, false);
      if (epoch !== this.epoch) throw fail('DISCONNECTED');
      if (typeof result.token !== 'string' || !result.token) throw fail('PROTOCOL_ERROR');
      this.jwt = result.token;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  connect(args) { return this.exclusive(async () => {
    const origin = this.optionsOrigin(args.url);
    if (typeof args.token !== 'string' || !args.token.trim() || args.token.length > 4096) throw fail('PAIRING_REQUIRED');
    this.disconnect();
    const epoch = this.epoch;
    this.origin = origin; this.accessToken = args.token.trim();
    const health = await this.json('/health', 'GET', undefined, false);
    if (health.status !== 'ok' || health.protocolVersion !== 1) throw fail('PROTOCOL_MISMATCH');
    await this.authenticate();
    const result = await this.json('/api/machines');
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
    this.patch({ sessionId: session.id, machineId: metadata.machineId, directory: metadata.path, streaming: false, messages: [], requests: [], thinking: false, error: undefined });
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
    let id = this.records[key]?.sessionId;
    if (args.restoreOnly && (!identifier(id) || id !== args.sessionId)) throw fail('NO_SESSION');
    if (args.restoreOnly && args.fresh) throw fail('INVALID_REQUEST');
    if (args.fresh || !identifier(id)) {
      const result = await this.json(`/api/machines/${encodeURIComponent(args.machineId)}/spawn`, 'POST', { directory: args.directory, agent: 'codex', permissionMode: 'read-only', sessionType: 'simple', startingMode: 'remote' });
      if (result.type !== 'success' || !identifier(result.sessionId)) throw fail('PROTOCOL_ERROR');
      id = result.sessionId;
    } else {
      const { session } = await this.json(`/api/sessions/${encodeURIComponent(id)}`);
      if (!session || session.id !== id) throw fail('PROTOCOL_ERROR');
      if (args.restoreOnly && (session.metadata?.path !== args.directory ||
          session.metadata?.machineId !== args.machineId ||
          args.threadId && (session.metadata?.codexThreadId || session.metadata?.codexSessionId) !== args.threadId)) throw fail('SESSION_MISMATCH');
      if (!session.active) {
        const result = await this.json(`/api/sessions/${encodeURIComponent(id)}/resume`, 'POST', { permissionMode: 'read-only' });
        if (result.type !== 'success' || !identifier(result.sessionId)) throw fail('PROTOCOL_ERROR');
        id = result.sessionId;
        if (args.restoreOnly) {
          const { session: resumed } = await this.json(`/api/sessions/${encodeURIComponent(id)}`);
          if (!resumed || resumed.metadata?.path !== args.directory || resumed.metadata?.machineId !== args.machineId ||
              !args.threadId || (resumed.metadata?.codexThreadId || resumed.metadata?.codexSessionId) !== args.threadId) throw fail('SESSION_MISMATCH');
        }
      }
    }
    // Only ids created by this client (or their explicit resume successor) can be used.
    if (epoch !== this.epoch) throw fail('DISCONNECTED');
    this.records[key] = { sessionId: id };
    await this.save();
    if (epoch !== this.epoch) throw fail('DISCONNECTED');
    this.patch({ sessionId: id, machineId: args.machineId, directory: args.directory, streaming: false, messages: [], requests: [], thinking: false, error: undefined });
    await this.refresh();
    this.streamTask = this.stream(epoch);
    return this.status();
  }); }
  async refresh(epoch = this.epoch) {
    const id = this.state.sessionId;
    if (!id) return;
    const { session } = await this.json(`/api/sessions/${encodeURIComponent(id)}`);
    const result = await this.json(`/api/sessions/${encodeURIComponent(id)}/messages?limit=200`);
    if (epoch !== this.epoch || id !== this.state.sessionId) return;
    if (!session || session.id !== id || !Array.isArray(result.messages)) throw fail('PROTOCOL_ERROR');
    const requests = object(session.agentState?.requests) ? Object.entries(session.agentState.requests).filter(([requestId]) => identifier(requestId)).map(([requestId, request]) => ({ id: requestId, tool: String(request?.tool || 'Tool') })) : [];
    this.patch({ active: !!session.active, thinking: !!session.thinking, threadId: session.metadata?.codexThreadId || session.metadata?.codexSessionId,
      model: session.model, permissionMode: session.permissionMode, requests,
      messages: projectMessages([...result.messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt - b.createdAt)), hasOlder: !!result.page?.hasMore });
  }
  async stream(epoch) {
    let attempts = 0;
    while (epoch === this.epoch && this.state.connected) {
      const controller = this.streamController = new AbortController();
      // Refresh even with a valid replay cursor. Full REST snapshots avoid stale patch resurrection.
      let timer = setTimeout(() => controller.abort(), 10000);
      try {
        const query = new URLSearchParams({ sessionId: this.state.sessionId, visibility: 'hidden' });
        if (this.cursor) query.set('lastEventId', this.cursor);
        const response = await this.raw(`/api/events?${query}`, 'GET', undefined, true, controller.signal);
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw fail('PROTOCOL_ERROR');
        this.patch({ streaming: true, error: undefined }); attempts = 0;
        for await (const { event, id } of sseFrames(response.body, controller.signal)) {
          clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000);
          if (epoch !== this.epoch) return;
          if (controller.signal.aborted) throw fail('NETWORK_ERROR');
          if (event.type === 'connection-changed' || event.sessionId === this.state.sessionId) await this.refresh(epoch);
          // No-id heartbeats preserve cursor. Failed refresh leaves it unchanged for replay.
          if (id) this.cursor = id;
        }
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.patch({ streaming: false, error: /^HAPI_[A-Z_]+$/.test(error?.message) ? error.message : 'HAPI_NETWORK_ERROR' });
        if (error?.message === 'HAPI_PAIRING_REQUIRED') return;
      } finally { clearTimeout(timer); controller.abort(); }
      if (epoch !== this.epoch) return;
      this.patch({ streaming: false });
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
  disconnect() {
    this.stopStream(); this.jwt = undefined; this.accessToken = undefined;
    this.patch({ connected: false, gateway: false, streaming: false, machines: [], messages: [], requests: [], sessionId: undefined, threadId: undefined, thinking: false, active: false, error: undefined });
  }
}

return { Hapi, hubOrigin, projectMessages, sseFrames };
};
if (typeof module === 'object' && module.exports) module.exports = factory;
else root.MoeCastHapiCore = factory;
})(globalThis);
