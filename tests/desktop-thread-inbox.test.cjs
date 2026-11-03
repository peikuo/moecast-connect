const {test}=require('node:test'),assert=require('node:assert/strict');
const thread='11111111-1111-4111-8111-111111111111',localId='22222222-2222-4222-8222-222222222222',queued='33333333-3333-4333-8333-333333333333';
async function fixture(options={}){
 const {DesktopThreadInbox}=await import('../skills/moecast-codex-connect/assets/runtime/scripts/codex/desktop-thread-inbox.mjs');const calls=[];
 const inbox=new DesktopThreadInbox({threadId:thread,platform:'darwin',codex:{rpc:async(method,p)=>{calls.push({method,p});return method==='thread/queue/add'?{queuedSubmission:{id:queued,clientUserMessageId:localId}}:{data:[]};}},run:async(command,args)=>{calls.push({command,args});return{stdout:'true\n'};},...options});
 return{inbox,calls};
}
test('desktop inbox forwards unchanged input only to its bound chat without starting an executor',async()=>{
 const f=await fixture();let attempted=false;assert.deepEqual(await f.inbox.send({text:'帮我找聊天并转达',localId,onAttempt:async()=>{attempted=true;f.calls.push({attempt:true})}}),{queuedSubmissionId:queued});
 assert.equal(attempted,true);assert.deepEqual(f.calls[3],{method:'thread/queue/add',p:{threadId:thread,clientUserMessageId:localId,input:[{type:'text',text:'消息来自 MoeCast。默认用中文回复；用户明确指定其他语言时遵从用户请求。'},{type:'text',text:'帮我找聊天并转达'}]}});
 assert.equal(f.calls.at(-1).args.at(-1),'codex://threads/wake/'+thread);assert.ok(!f.calls.some(c=>/resume|turn\/start|spawn|tools\/call/.test(c.method??c.command??'')));
});
test('closed desktop fails before attempted delivery',async()=>{
 const f=await fixture({run:async()=>({stdout:'false\n'})});await assert.rejects(f.inbox.send({text:'test',localId,onAttempt:()=>assert.fail('must not attempt')}),/DESKTOP_INBOX_OFFLINE/);assert.equal(f.calls.length,0);
});
test('uncertain enqueue does not wake or retry',async()=>{
 let count=0;const f=await fixture({codex:{rpc:async(method)=>{if(method==='thread/queue/add'){count++;throw Error('NETWORK_CLOSED');}return{data:[]};}}});await assert.rejects(f.inbox.send({text:'test',localId}),/NETWORK_CLOSED/);assert.equal(count,1);assert.ok(!f.calls.some(c=>c.command==='/usr/bin/open'));
});
test('unsupported platform and invalid messages never enqueue',async()=>{
 const f=await fixture({platform:'linux'});await assert.rejects(f.inbox.send({text:'test',localId}),/DESKTOP_INBOX_UNAVAILABLE/);await assert.rejects(f.inbox.send({text:' ',localId}),/INVALID_ASSISTANT_REQUEST/);assert.equal(f.calls.length,0);
});

test('English app language is minimal context and preserves an explicit language request verbatim',async()=>{const f=await fixture();await f.inbox.send({text:'请用中文回答',locale:'en-US',localId});const input=f.calls.find(c=>c.method==='thread/queue/add').p.input;assert.match(input[0].text,/English by default/);assert.match(input[0].text,/explicitly requests/);assert.equal(input[1].text,'请用中文回答');assert.equal(input.length,2);});

test('Windows native inbox queues once then wakes the exact existing desktop thread',async()=>{
 const calls=[];const f=await fixture({platform:'win32',run:async(command,args,options)=>{calls.push({command,args,options});return{stdout:'True\n'};}});
 await f.inbox.send({text:'保持原话 & 不当成 shell',localId});
 assert.equal(calls.length,2);assert.equal(calls[0].command,'powershell.exe');assert.equal(calls[0].options.windowsHide,true);
 assert.match(calls[0].args.at(-1),/Get-Process -Name Codex/);
 assert.equal(calls[1].options.env.MOECAST_DESKTOP_URI,'codex://threads/wake/'+thread);
 assert.match(calls[1].args.at(-1),/Start-Process -FilePath \$env:MOECAST_DESKTOP_URI/);
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
 assert.ok(!f.calls.some(c=>/resume|turn\/start/.test(c.method??'')));
});
test('Windows desktop closed or a failed wake never triggers a second enqueue',async()=>{
 let attempted=0;const closed=await fixture({platform:'win32',run:async()=>({stdout:'False'})});
 await assert.rejects(closed.inbox.send({text:'test',localId,onAttempt:()=>attempted++}),/DESKTOP_INBOX_OFFLINE/);assert.equal(attempted,0);
 let opens=0;const fail=await fixture({platform:'win32',run:async()=>{if(opens++)throw Error('WAKE_FAILED');return{stdout:'True'};}});
 await assert.rejects(fail.inbox.send({text:'test',localId}),/WAKE_FAILED/);assert.equal(fail.calls.filter(c=>c.method==='thread/queue/add').length,1);
});
