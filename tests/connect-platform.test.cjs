const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const load=()=>import('../skills/moecast-codex-connect/assets/runtime/scripts/codex/connect-platform.mjs');
test('Windows admin endpoint is stable across path casing and isolated between installations',async()=>{
 const{adminEndpoint}=await load();const a=adminEndpoint('C:\\Users\\Alice\\App Data\\连接','win32');
 assert.match(a.path,/^\\\\\.\\pipe\\moecast-connect-[a-f0-9]{32}$/);
 assert.equal(a.path,adminEndpoint('c:\\users\\alice\\app data\\连接','win32').path);
 assert.notEqual(a.path,adminEndpoint('C:\\Users\\Bob\\App Data','win32').path);
 assert.equal(adminEndpoint('/tmp/one','darwin'),'/tmp/one/admin.sock');
});
test('pairing preserves native absolute directories on its host rather than assuming POSIX paths',async t=>{
 const{DeviceStore}=await import('../skills/moecast-codex-connect/assets/runtime/scripts/codex/hapi-device-store.mjs');const{randomUUID}=require('node:crypto');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'moecast pairing 用户 '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new DeviceStore(path.join(root,'devices.json'));await store.load();const threadId=randomUUID();
 const selection={sessionId:threadId,threadId,machineId:randomUUID(),directory:root};
 const invitation=await store.issuePairing({selection});const paired=await store.pair(invitation.code);
 assert.deepEqual(paired.selection,selection);
 await assert.rejects(store.issuePairing({selection:{...selection,directory:'relative'}}),/INVALID_FRONTDESK_BINDING/);
});
test('Windows process ownership checks executable and exact decoded arguments, including spaces and Chinese',async()=>{
 const{ownsProcess,windowsArgs}=await load();
 const executable='C:\\Program Files\\nodejs\\node.exe',script='C:\\Users\\用户\\连接 工具\\scripts\\hapi-connect.mjs';
 const run=()=>JSON.stringify({executable,command:`"${executable}" "${script}" serve`});
 assert.equal(ownsProcess(123,executable,[script,'serve'],{platform:'win32',run}),true);
 assert.equal(ownsProcess(123,executable,[script,'stop'],{platform:'win32',run}),false);
 assert.equal(ownsProcess(123,'C:\\other\\node.exe',[script,'serve'],{platform:'win32',run}),false);
 assert.equal(ownsProcess(-1,executable,[],{platform:'win32',run:()=>assert.fail()}),false);
 assert.deepEqual(windowsArgs('"C:\\Program Files\\node.exe" "C:\\你好\\file.mjs" serve'),['C:\\Program Files\\node.exe','C:\\你好\\file.mjs','serve']);
});
test('Windows port inspection and ACL do not interpolate paths into PowerShell source',async t=>{
 const{privateDirectory,listeningPids}=await load();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moecast windows 用户 & '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const calls=[];
 const run=(command,args,options)=>{calls.push({command,args,options});return command==='powershell.exe'?'S-1-5-21-123-456-789-1001':'ok';};
 await privateDirectory(dir,{platform:'win32',run});
 assert.equal(calls[1].command,'icacls.exe');assert.deepEqual(calls[1].args,[dir,'/inheritance:r','/grant:r','*S-1-5-21-123-456-789-1001:(OI)(CI)F']);
 assert.equal(calls[0].args.some(v=>v.includes(dir)),false);
 assert.deepEqual(listeningPids(3317,{platform:'win32',run:(command,args,options)=>{assert.equal(options.env.MOECAST_QUERY_PORT,'3317');return '42\n43';}}),[42,43]);
 assert.throws(()=>listeningPids(0),/INVALID_PORT/);
});
test('authenticated local administration rejects a missing or wrong capability without exposing it',async t=>{
 const{DeviceGateway,adminRequest}=await import('../skills/moecast-codex-connect/assets/runtime/scripts/codex/hapi-gateway.mjs');
 const{adminEndpoint,privateDirectory}=await load();
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'moecast-admin-auth-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await privateDirectory(root);
 const endpoint=process.platform==='win32'?adminEndpoint(root):{path:path.join(root,'admin.sock'),tokenFile:path.join(root,'admin-token')};
 const gateway=new DeviceGateway({store:{file:path.join(root,'devices.json'),listeners:new Set(),list:()=>[{id:'test-device'}]},directory:{}});
 await gateway.listen(0);await gateway.admin(endpoint);t.after(()=>gateway.close());
 assert.deepEqual(await adminRequest(endpoint,{action:'devices'}),[{id:'test-device'}]);
 await assert.rejects(adminRequest(endpoint.path,{action:'devices'}),/ADMIN_ACCESS_DENIED/);
 await fs.writeFile(endpoint.tokenFile,'wrong');await assert.rejects(adminRequest(endpoint,{action:'devices'}),/ADMIN_ACCESS_DENIED/);
});
test('Windows CI exercises actual process, ACL, named pipe and npm discovery without desktop or pairing', {skip:process.platform!=='win32'},async t=>{
 const{ownsProcess,npmInvocation,desktopRunning}=await load();
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'moecast process 用户 '));const script=path.join(root,'worker test.cjs');await fs.writeFile(script,'setInterval(()=>{},1000)');const child=require('node:child_process').spawn(process.execPath,[script],{windowsHide:true});t.after(async()=>{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(root,{recursive:true,force:true});});
 assert.equal(ownsProcess(child.pid,process.execPath,[script]),true);
 assert.equal(ownsProcess(child.pid,process.execPath,['foreign-file.mjs']),false);
 const npm=await npmInvocation();assert.equal(npm.file,process.execPath);assert.match(npm.args[0],/npm-cli\.js$/i);
 assert.equal(desktopRunning(),false); // GitHub runner has no signed-in Codex desktop.
});
test('Windows CI installs in isolated state and reports missing desktop without starting a service', {skip:process.platform!=='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'moecast isolated 用户 '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const helper=path.join(process.cwd(),'skills/moecast-codex-connect/scripts/connect.mjs');
 const run=command=>JSON.parse(require('node:child_process').execFileSync(process.execPath,[helper,command],{env:{...process.env,MOECAST_CONNECT_HOME:root},encoding:'utf8',timeout:180000,windowsHide:true}));
 const installed=run('install');assert.equal(installed.installed,true);const report=run('doctor');
 assert.equal(report.skillVersion,installed.version);assert.equal(report.installedVersion,installed.version);
 assert.equal(report.checks.platform.ok,true);assert.equal(report.checks.platform.value,'win32-x64');assert.equal(report.checks.runtimeIntegrity.ok,true);
 assert.equal(report.checks.desktopRunning.ok,false);assert.equal(report.serviceReady,false);
 assert.equal(report.autostart,false);assert.equal(report.supervisor,false);
 await assert.rejects(fs.stat(path.join(root,'gateway/runtime.json')),e=>e.code==='ENOENT');
});
