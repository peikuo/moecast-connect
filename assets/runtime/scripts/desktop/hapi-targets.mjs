// Shared headless protocol. Call prepare only after a dispatch intent was established.
// No confidence score, fuzzy match, speech, or UI. Selection is an explicit action.
const clean = value => typeof value === 'string' ? value.trim() : '';
const normalize = value => clean(value).normalize('NFKC').toLocaleLowerCase();
export const selectionBinding = ({text,hint,project,focusId,referenceId}) => JSON.stringify([text,hint??null,project??null,focusId??null,referenceId??null]);
export function targetCard(session) {
  const metadata = session.metadata ?? {};
  const threadId = metadata.codexThreadId || metadata.codexSessionId;
  return {
    id: session.id, threadId: clean(threadId), machineId: clean(metadata.machineId),
    project: clean(metadata.path), label: clean(metadata.name) || clean(metadata.summary?.text) || session.id,
    summary: clean(metadata.summary?.text).slice(0, 300), updatedAt: session.updatedAt,
    state: !session.active ? 'offline' : Object.keys(session.agentState?.requests ?? {}).length ? 'waiting_permission' : session.thinking ? 'working' : 'idle',
    aliases: [],
  };
}
const identity = card => JSON.stringify([card.id, card.threadId, card.machineId, card.project]);
export class TargetSelection {
  constructor(port, { now = Date.now, uuid = () => crypto.randomUUID(), ttlMs = 300000 } = {}) {
    this.port = port; this.now = now; this.uuid = uuid; this.ttlMs = ttlMs; this.pending = new Map();
  }
  async prepare({ text, hint, project, focusId, referenceId, requestId }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw Error('INVALID_DISPATCH');
    const binding=selectionBinding({text,hint,project,focusId,referenceId});
    const ticket=requestId??this.uuid();
    if(typeof ticket!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(ticket))throw Error('INVALID_DISPATCH');
    const prior=this.pending.get(ticket);
    if(prior){
      if(prior.binding!==binding)throw Error('REQUEST_ID_CONFLICT');
      if(prior.state==='cancelled')throw Error('SELECTION_CANCELLED');
      if(prior.expiresAt<=this.now())throw Error('SELECTION_EXPIRED');
      return structuredClone(prior.publicResult);
    }
    const catalog = await this.port.list();
    if (catalog.some(c => !c.id || !c.label) || new Set(catalog.map(c => c.id)).size !== catalog.length) throw Error('INVALID_CATALOG');
    let candidates = catalog.filter(c => !project || c.project === project);
    // Only exact names/confirmed aliases or an explicit stable reference can auto-select.
    // Never prefer a focus over a newly supplied, unmatched target.
    if (hint) candidates = candidates.filter(c => [c.label, ...(c.aliases ?? [])].some(s => normalize(s) === normalize(hint)));
    else if (referenceId || focusId) candidates = candidates.filter(c => c.id === (referenceId || focusId));
    const explicit = !!(hint || referenceId || focusId);
    this.prune();
    if (this.pending.size >= 32) throw Error('TOO_MANY_SELECTIONS');
    const publicResult={kind:explicit&&candidates.length===1?'ready':'selection_required',ticket,candidates:structuredClone(candidates),speech:null,expiresAt:this.now()+this.ttlMs};
    this.pending.set(ticket, { text, binding, publicResult, candidates: structuredClone(candidates), expiresAt: publicResult.expiresAt, state: 'pending' });
    return structuredClone(publicResult);
  }
  prune() { for (const [key, value] of this.pending) if (value.expiresAt <= this.now() && value.state !== 'sending') this.pending.delete(key); }
  cancel(ticket) {
    const pending = this.pending.get(ticket);
    if (!pending || pending.state !== 'pending') throw Error('SELECTION_NOT_PENDING');
    pending.state='cancelled'; return { cancelled: true };
  }
  select(ticket, id) {
    const pending = this.pending.get(ticket);
    if (!pending || pending.state==='cancelled' || pending.expiresAt <= this.now()) return Promise.reject(Error('SELECTION_EXPIRED'));
    const original = pending.candidates.find(c => c.id === id);
    if (!original) return Promise.reject(Error('TARGET_NOT_OFFERED'));
    if (pending.selectedId && pending.selectedId !== id) return Promise.reject(Error('SELECTION_ALREADY_USED'));
    if (pending.result) return pending.result;
    pending.state = 'sending'; pending.selectedId = id;
    pending.result = (async () => {
      const current = (await this.port.list()).find(c => c.id === id);
      if (!current || identity(current) !== identity(original)) throw Error('TARGET_CHANGED');
      if (!['idle','resumable'].includes(current.state)) throw Error('TARGET_NOT_READY');
      // Original text and one stable request id; duplicate clicks share the same promise.
      return this.port.dispatch(id, pending.text, ticket);
    })().finally(()=>{pending.state='submitted';});
    return pending.result;
  }
}
