// Shared text synchronization policy; no UI, Agent, background worker or model calls.
(function(root) {
  function merge(record, rows, now) {
    const messages = new Map(record.messages.map(row => [row.id, row]));
    const notices = new Set(record.notices);
    for (const row of rows) {
      const previous = messages.get(row.id);
      const createdAt = previous?.createdAt > 0 && row.createdAt > 0 ? Math.min(previous.createdAt, row.createdAt) : previous?.createdAt || row.createdAt;
      messages.set(row.id, {...(previous && (previous.seq ?? 0) > (row.seq ?? 0) ? previous : row), createdAt});
      // Baseline is computer time at first sync, not phone receive time or an inferred read receipt.
      if (!previous && record.baselineAt && row.role === 'agent' && row.createdAt > record.baselineAt && row.createdAt <= now && now - row.createdAt <= 30 * 60000) notices.add(row.id);
    }
    record.messages = [...messages.values()].sort((a,b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id));
    record.notices = [...notices].filter(id => {
      const row = messages.get(id);return row && row.createdAt > (record.baselineAt??0) && row.createdAt <= now && now - row.createdAt <= 30 * 60000;
    });
  }
  function freshRecord() {return {version:1, messages:[], notices:[], baselineAt:null, cursors:[], complete:false, epoch:null, warning:null, failures:0, retryAt:0};}
  class MessageSync {
    constructor({load,save,read,now=Date.now,maxPages=4}) {Object.assign(this,{load,save,read,now,maxPages});}
    async run(first,valid=()=>true) {
      const saved = await this.load();
      const record = saved ?? freshRecord();
      if (record.version !== 1 || !Array.isArray(record.messages) || !Array.isArray(record.cursors) || !Array.isArray(record.notices)) throw Error('HAPI_STORAGE_ERROR');
      const now = Number.isFinite(first.serverTime) && first.serverTime > 0 ? first.serverTime : 0;
      // A server epoch change invalidates cursors. Rebuild explicitly, retaining the old cache until new history is complete.
      if (record.epoch !== null && first.page?.epoch !== undefined && record.epoch !== first.page.epoch) {
        record.cursors=[];record.complete=false;record.warning='HISTORY_CHANGED';record.rebuilding=[];
      }
      record.epoch=first.page?.epoch ?? record.epoch;
      const rebuilt=record.rebuilding?new Set(record.rebuilding):null;
      const known = new Map(record.messages.filter(row=>!rebuilt||rebuilt.has(row.id)).map(row=>[row.id,row.seq??0]));
      const anchored=row=>known.has(row.id)&&(row.seq??0)<=known.get(row.id);
      const overlap = first.messages.some(anchored);
      const enqueue=(page,stopAtKnown,trail=[])=>{
        if (!page?.hasMore) return;
        if (typeof page.nextCursor !== 'string' || !page.nextCursor) {record.complete=false;record.warning='PAGINATION_UNAVAILABLE';return;}
        if(record.warning==='PAGINATION_UNAVAILABLE')record.warning=null;
        if (!record.cursors.some(task=>task.cursor===page.nextCursor)) record.cursors.push({cursor:page.nextCursor,stopAtKnown,trail});
      };
      if(record.rebuilding)record.rebuilding.push(...first.messages.map(row=>row.id));
      merge(record,first.messages,now);
      if (first.page?.hasMore && (!overlap || !saved || !record.complete&&!record.cursors.length)) enqueue(first.page,!!record.complete&&!record.rebuilding);
      if (!first.page?.hasMore) {
        if(record.rebuilding || !saved || overlap || !known.size) {record.complete=true;record.cursors=[];}
        else {record.complete=false;record.warning='HISTORY_GAP';}
      }
      if(!first.page?.hasMore&&record.complete&&!record.cursors.length&&['TEMPORARY_SYNC_FAILURE','PAGINATION_UNAVAILABLE','PAGINATION_STALLED'].includes(record.warning))record.warning=null;
      if (record.baselineAt === null && now) record.baselineAt=now;
      let pages=1;
      while (record.cursors.length && pages < this.maxPages && this.now() >= record.retryAt) {
        if (!valid()) return null;
        const task=record.cursors[0];
        try {
          const page=await this.read(task.cursor);pages++;
          if (!valid()) return null;
          if (record.epoch !== null && page.page?.epoch !== undefined && page.page.epoch !== record.epoch) throw Error('HISTORY_CHANGED');
          const overlaps=page.messages.some(anchored);
          if(record.rebuilding)record.rebuilding.push(...page.messages.map(row=>row.id));
          merge(record,page.messages,now);
          record.cursors.shift();
          if(['TEMPORARY_SYNC_FAILURE','PAGINATION_STALLED'].includes(record.warning))record.warning=null;
          if (page.page?.hasMore && !(task.stopAtKnown && overlaps)) {
            if ([...(task.trail??[]),task.cursor].includes(page.page.nextCursor)) throw Error('PAGINATION_STALLED');
            enqueue(page.page,task.stopAtKnown,[...(task.trail??[]),task.cursor]);
          } else if (!page.page?.hasMore) record.complete=true;
          record.failures=0;record.retryAt=0;
        } catch(error) {
          if (!record.cursors.some(item=>item.cursor===task.cursor)) record.cursors.unshift(task);
          record.failures++;record.retryAt=this.now()+Math.min(60000,5000*3**Math.min(record.failures-1,3));
          record.warning=['HISTORY_CHANGED','PAGINATION_STALLED'].includes(error.message)?error.message:'TEMPORARY_SYNC_FAILURE';break;
        }
        if (!valid()) return null;
        await this.save(record);
      }
      if(record.rebuilding && record.complete && !record.cursors.length){
        const current=new Set(record.rebuilding);record.messages=record.messages.filter(row=>current.has(row.id));
        record.notices=record.notices.filter(id=>current.has(id));delete record.rebuilding;
        if(record.warning==='HISTORY_CHANGED')record.warning=null;
      }
      if (!valid()) return null;
      await this.save(record);
      return {...record, complete:record.complete && record.cursors.length===0 && !record.warning};
    }
  }
  const api={MessageSync,mergeMessages:merge};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.MoeCastMessageSync=api;
})(globalThis);
