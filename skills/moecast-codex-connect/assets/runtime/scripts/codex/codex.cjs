const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const weatherTools = ['location_resolve', 'weather_current', 'weather_daily', 'weather_hourly'];
const currentRules = new WeakMap();
const allowedTools = new Set([...weatherTools, 'sleep_session_start', 'sleep_session_read', 'sleep_session_control']);
const failure = code => new Error(code);

/** One local App Server. Only MoeCast-owned thread IDs are resumed; no auth files are read. */
class Codex {
  constructor(root, emit, options = {}) {
    this.root = root; this.emit = emit; this.spawn = options.spawn || spawn;
    this.platform = options.platform || process.platform; this.paths = options.paths;
    this.pending = new Map(); this.tools = new Map(); this.serial = 0;
    this.file = path.join(root, 'codex-sessions.json'); this.cwd = path.join(root, 'codex-workspace');
  }
  async locate() {
    let selected;
    try { selected = JSON.parse(await fs.readFile(path.join(this.root, 'codex-executable.json'), 'utf8')).path; } catch { /* Optional user-selected installation. */ }
    const candidates = this.paths || [
      ...(typeof selected === 'string' && path.isAbsolute(selected) ? [selected] : []),
      ...(this.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/Codex.app/Contents/Resources/codex'] : []),
      path.join(os.homedir(), '.local', 'bin', this.platform === 'win32' ? 'codex.exe' : 'codex'),
      ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => this.platform === 'win32'
        ? [path.join(dir, 'codex.exe'), path.join(dir, 'node_modules/@openai/codex/bin/codex.js'), ...['@openai/codex', '@openai/codex-win32-x64'].map(pkg => path.join(dir, 'node_modules', pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'))]
        : [path.join(dir, 'codex')]),
    ];
    for (const candidate of candidates) try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try the next official installation path. */ }
    throw failure('CODEX_NOT_INSTALLED');
  }
  async selectExecutable(file) {
    if (this.run) throw failure('CODEX_BUSY');
    if (!path.isAbsolute(file) || !(await fs.stat(file)).isFile()) throw failure('CODEX_NOT_INSTALLED');
    if (/\.cmd$/i.test(file)) file = path.join(path.dirname(file), 'node_modules/@openai/codex/bin/codex.js');
    if (!(await fs.stat(file)).isFile()) throw failure('CODEX_NOT_INSTALLED');
    this.close(); this.binary = undefined;
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, 'codex-executable.json'), JSON.stringify({ path: file }), { mode: 0o600 });
    return this.status();
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().catch(error => { this.close(); throw error; });
    return this.connecting;
  }
  async open() {
    const binary = await this.locate();
    await fs.mkdir(this.cwd, { recursive: true });
    this.binary = binary;
    const resolved = await fs.realpath(binary);
    const script = /\.[cm]?js$/i.test(resolved);
    this.child = this.spawn(script ? process.execPath : binary, [...(script ? [resolved] : []), 'app-server', '--stdio'], { cwd: this.cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.child;
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child) return;
      let message; try { message = JSON.parse(line); } catch { return; }
      this.receive(message);
    });
    child.on('error', () => { if (this.child === child) this.close('CODEX_START_FAILED'); });
    child.on('exit', () => { if (this.child === child) this.close('CODEX_EXITED'); });
    await this.rpc('initialize', { clientInfo: { name: 'moecast_desktop', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
    let saved;
    try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw failure('CODEX_STORAGE_ERROR'); }
    this.sessions = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    this.loaded = new Set();
  }
  write(message) { if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n'); else throw failure('CODEX_EXITED'); }
  rpc(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('CODEX_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      if (message.method === 'item/tool/call') this.toolCall(message);
      else this.write({ id: message.id, error: { code: -32601, message: 'MoeCast does not grant this capability' } });
      return;
    }
    if (message.id !== undefined) {
      const item = this.pending.get(message.id); if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(failure(/auth|login/i.test(message.error.message || '') ? 'CODEX_LOGIN_REQUIRED' : 'CODEX_REQUEST_FAILED'));
      else item.resolve(message.result);
      return;
    }
    const run = this.run, p = message.params;
    if (!run || !p || p.threadId !== run.threadId) return;
    if (message.method === 'turn/started') { run.turnId = p.turn.id; if (run.cancelled) void this.interrupt(run); }
    if (message.method === 'item/agentMessage/delta' && !run.cancelled) this.emit({ type: 'delta', runId: run.id, text: p.delta });
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && !run.cancelled) {
      if (p.item.phase !== 'commentary') run.messages.push(p.item.text || '');
      if (p.item.phase === 'final_answer') run.finalMessage = p.item.text || '';
      this.emit({ type: 'message', runId: run.id, text: run.messages.join('\n') });
    }
    if (message.method === 'turn/completed' && (!run.turnId || p.turn.id === run.turnId)) {
      run.turnId = p.turn.id;
      if (run.cancelled || p.turn.status === 'interrupted') run.resolve({ text: '', cancelled: true });
      else if (p.turn.status === 'completed') run.resolve({ text: run.finalMessage ?? run.messages.join('\n'), model: run.model });
      else {
        const code = /429|rate.limit/i.test(p.turn.error?.message || '') ? 'CODEX_RATE_LIMITED' : /auth|login/i.test(p.turn.error?.message || '') ? 'CODEX_LOGIN_REQUIRED' : 'CODEX_REQUEST_FAILED';
        run.reject(failure(code));
      }
    }
  }
  async status() {
    try {
      await this.connect();
      const account = await this.rpc('account/read', { refreshToken: false });
      if (!account.account) return { available: true, authenticated: false, reason: 'CODEX_LOGIN_REQUIRED' };
      const models = await this.rpc('model/list');
      const model = models.data?.find(item => item.isDefault)?.model || models.data?.[0]?.model;
      if (!model) throw failure('CODEX_MODEL_UNAVAILABLE');
      this.model = model;
      return { available: true, authenticated: true, model };
    } catch (error) { return { available: !!this.binary, authenticated: false, reason: /^CODEX_/.test(error.message) ? error.message : 'CODEX_START_FAILED' }; }
  }
  async send(args) {
    if (this.run) throw failure('CODEX_BUSY');
    if (!args || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.sessionId || '') || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.runId || '')
      || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 40000
      || typeof args.instructions !== 'string' || args.instructions.length > 60000 || !['zh', 'en'].includes(args.language)
      || !Array.isArray(args.tools) || !([4, 7].includes(args.tools.length)) || new Set(args.tools.map(t => t.name)).size !== args.tools.length
      || weatherTools.some(name => !args.tools.some(t => t.name === name))
      || args.tools.some(t => !allowedTools.has(t.name) || typeof t.description !== 'string' || !t.inputSchema || typeof t.inputSchema !== 'object')) throw failure('CODEX_INVALID_REQUEST');
    // Reserve admission before any asynchronous startup or disk operation.
    let settle, reject;
    const result = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    // Settlement can happen during startup (including cancellation).
    result.catch(() => {});
    const run = this.run = { id: args.runId, messages: [], toolNames: new Set(args.tools.map(t => t.name)), resolve: settle, reject, cancelled: false };
    const timeout = setTimeout(() => { this.close('CODEX_TIMEOUT'); }, 180000);
    try {
      const status = await this.status();
      if (!status.authenticated) throw failure(status.reason);
      if (run.cancelled) return { text: '', cancelled: true };
      const rules = `${args.instructions}\n${args.language === 'zh' ? '宿主确认执行引擎为 Codex，模型为' : 'Host-confirmed engine: Codex. Model:'} ${status.model}.\n${args.language === 'zh' ? '不访问本地文件，不运行 shell，不委派任务。天气事实优先使用 App 注册的天气工具；缺失就说明未知。' : 'Do not access local files, run shell commands, or delegate tasks. Prefer the registered App weather tools for weather facts; admit unavailable data.'}`;
      let record = this.sessions[args.sessionId];
      if (record && (!record.threadId || typeof record.threadId !== 'string')) throw failure('CODEX_STORAGE_ERROR');
      const options = { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only' };
      if (!record) {
        const started = await this.rpc('thread/start', { ...options, model: status.model, developerInstructions: rules, config: { web_search: 'live' }, dynamicTools: args.tools.map(t => ({ type: 'function', ...t })) });
        record = { threadId: started.thread.id, language: args.language };
        this.sessions[args.sessionId] = record;
        await fs.writeFile(this.file + '.new', JSON.stringify(this.sessions), { mode: 0o600 });
        await fs.rename(this.file + '.new', this.file);
        this.loaded.add(record.threadId);
      } else if (!this.loaded.has(record.threadId)) {
        await this.rpc('thread/resume', { ...options, threadId: record.threadId, excludeTurns: true });
        await this.rpc('thread/inject_items', { threadId: record.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: rules }] }] });
        this.loaded.add(record.threadId); record.language = args.language;
      } else if (record.language !== args.language || currentRules.get(record) !== rules) {
        await this.rpc('thread/inject_items', { threadId: record.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: rules }] }] });
        record.language = args.language;
      }
      currentRules.set(record, rules);
      run.threadId = record.threadId; run.model = status.model;
      if (run.cancelled) return { text: '', cancelled: true };
      const turn = await this.rpc('turn/start', { threadId: record.threadId, model: status.model, input: [{ type: 'text', text: args.text }], effort: 'low' });
      run.turnId = turn.turn.id;
      if (run.cancelled) void this.interrupt(run);
      return await result;
    } finally {
      clearTimeout(timeout);
      clearTimeout(run.cancelTimer);
      for (const [id, tool] of this.tools) if (tool.runId === run.id) { clearTimeout(tool.timer); this.tools.delete(id); }
      if (this.run === run) this.run = null;
    }
  }
  toolCall(message) {
    const run = this.run, p = message.params;
    if (!run || run.cancelled || p.threadId !== run.threadId || !run.toolNames.has(p.tool) || this.tools.size >= 8) {
      this.write({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Tool unavailable or cancelled' }] } }); return;
    }
    const callId = randomUUID();
    const timer = setTimeout(() => { this.toolResult({ callId, runId: run.id, success: false, text: 'Weather data request timed out' }); }, 30000);
    this.tools.set(callId, { rpcId: message.id, runId: run.id, timer });
    this.emit({ type: 'tool', runId: run.id, callId, name: p.tool, args: p.arguments });
  }
  toolResult(args) {
    const item = this.tools.get(args.callId);
    if (!item || args.runId !== item.runId || this.run?.id !== item.runId || this.run.cancelled) return;
    if (typeof args.text !== 'string' || args.text.length > 150000) throw failure('CODEX_INVALID_TOOL_RESULT');
    clearTimeout(item.timer); this.tools.delete(args.callId);
    this.write({ id: item.rpcId, result: { success: args.success === true, contentItems: [{ type: 'inputText', text: args.text }] } });
  }
  async interrupt(run) {
    if (!run.threadId || !run.turnId) return;
    try { await this.rpc('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }); } catch { this.close('CODEX_CANCELLED'); }
  }
  cancel(runId) {
    const run = this.run;
    if (!run || runId && run.id !== runId) return;
    run.cancelled = true;
    for (const [id, tool] of this.tools) { clearTimeout(tool.timer); this.tools.delete(id); try { this.write({ id: tool.rpcId, result: { success: false, contentItems: [{ type: 'inputText', text: 'Cancelled' }] } }); } catch {} }
    // Kill only this owned App Server if cancellation does not finish promptly.
    if (!run.cancelTimer) run.cancelTimer = setTimeout(() => { if (this.run === run) this.close('CODEX_CANCELLED'); }, 3000);
    void this.interrupt(run);
  }
  close(code = 'CODEX_EXITED') {
    const child = this.child; this.child = null; this.connecting = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(failure(code)); } this.pending.clear();
    for (const item of this.tools.values()) clearTimeout(item.timer); this.tools.clear();
    if (this.run) { clearTimeout(this.run.cancelTimer); this.run.reject(failure(this.run.cancelled ? 'CODEX_CANCELLED' : code)); }
    child?.stdin.end(); child?.kill('SIGTERM');
  }
}
module.exports = { Codex };
