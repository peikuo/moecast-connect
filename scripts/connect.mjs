#!/usr/bin/env node
// Local installation/diagnostics; no MCP, startup registration, or process supervisor.
import fs from 'node:fs/promises';
import {hubUrl,gatewayUrl} from '../assets/runtime/scripts/desktop/hapi-ports.mjs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const skill=path.resolve(import.meta.dirname,'..'),release=JSON.parse(await fs.readFile(path.join(skill,'release.json'),'utf8'));
async function canonicalLocation(location){
 let current=path.resolve(location);const suffix=[];
 while(true){try{return path.join(await fs.realpath(current),...suffix);}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(current);if(parent===current)throw e;suffix.unshift(path.basename(current));current=parent;}}
}
const base=await canonicalLocation(process.env.MOECAST_CONNECT_HOME||path.join(os.homedir(),'.local/share/moecast-connect'));
const runtime=path.join(base,'app'),hapi=path.join(base,'hapi'),gateway=path.join(base,'gateway');
const args=process.argv.slice(2),command=args.shift()||'doctor';
let phase=command;
const env={...process.env,MOECAST_CONNECT_HOME:base,NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1'};
if(!env.HTTPS_PROXY&&!env.https_proxy&&process.platform==='darwin')try{const s=execFileSync('scutil',['--proxy'],{encoding:'utf8'});const host=s.match(/HTTPSProxy : (\S+)/)?.[1],port=s.match(/HTTPSPort : (\d+)/)?.[1];if(/HTTPSEnable : 1/.test(s)&&host&&port){env.HTTPS_PROXY=`http://${host}:${port}`;env.HTTP_PROXY=env.HTTPS_PROXY;}}catch{}
const binary=path.join(hapi,'runtime/package/bin/hapi');
const run=(file,argv,options={})=>execFileSync(file,argv,{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000,...options});
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function privateJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID();await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,file);}
async function verifyRuntime(folder){const m=await json(path.join(folder,'source-manifest.json'));for(const [f,expected]of Object.entries(m.files)){if(path.isAbsolute(f)||f.split('/').includes('..')||await hash(path.join(folder,f))!==expected)throw Error('RUNTIME_INTEGRITY_MISMATCH');}}
async function install(){
 if(`${process.platform}-${process.arch}`!==release.platform)throw Error('SUPPORTED_PLATFORM_IS_MAC_APPLE_SILICON');
 if(Number(process.versions.node.split('.')[0])<22)throw Error('NODE_22_REQUIRED');
 await fs.mkdir(base,{recursive:true,mode:0o700});await fs.chmod(base,0o700);
 const stage=path.join(base,'.install-'+randomUUID());await fs.mkdir(stage,{mode:0o700});
 try{
  const appStage=path.join(stage,'app');await fs.cp(path.join(skill,'assets/runtime'),appStage,{recursive:true});
  // Git/Skills installs omit the native binary; the complete archive can work offline here.
  const tunnelFile=path.join(appStage,'scripts/connect/tunwg/tunwg');
  if(!await exists(tunnelFile)){
   phase='tunnel-download';const origin=new URL(release.tunnel?.url);
   if(origin.protocol!=='https:'||origin.hostname!=='moecast.aixagent.cloud'||!origin.pathname.startsWith('/connect/')||origin.username||origin.password||origin.search||origin.hash)throw Error('TUNNEL_SOURCE_INVALID');
   run('curl',['--fail','--silent','--show-error','--max-time','60','--output',tunnelFile,origin.href],{timeout:65000});
   if(await hash(tunnelFile)!==release.tunnel.sha256)throw Error('TUNNEL_INTEGRITY_MISMATCH');
  }
  await fs.chmod(tunnelFile,0o700);await verifyRuntime(appStage);
  phase='runtime-dependencies';run('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--fetch-timeout=20000','--fetch-retries=1'],{cwd:appStage});
  // Download upstream separately. No HAPI binary or account data is distributed in the Skill.
  const archiveStage=path.join(stage,'upstream');await fs.mkdir(archiveStage);
  phase='hapi-download';let packed,archive;
  const archiveIndex=args.indexOf('--hapi-archive');
  if(archiveIndex>=0){if(!args[archiveIndex+1])throw Error('HAPI_ARCHIVE_PATH_REQUIRED');archive=path.resolve(args[archiveIndex+1]);}
  else {
   // A mirror changes transport only; the same release-pinned integrity remains mandatory.
   for(const registry of [release.hapi.registry,'https://registry.npmmirror.com'])try{packed=JSON.parse(run('npm',['pack',`${release.hapi.package}@${release.hapi.version}`,'--ignore-scripts','--json','--registry='+registry,'--pack-destination',archiveStage,'--fetch-timeout=12000','--fetch-retries=0']))[0];break;}catch{}
   if(!packed)throw Error('HAPI_DOWNLOAD_UNAVAILABLE');archive=path.join(archiveStage,path.basename(packed.filename));
  }
  phase='hapi-integrity';
  const integrity='sha512-'+createHash('sha512').update(await fs.readFile(archive)).digest('base64');if(integrity!==release.hapi.integrity)throw Error('HAPI_INTEGRITY_MISMATCH');
  const entries=run('tar',['-tzf',archive]).trim().split('\n');if(entries.some(f=>!f.startsWith('package/')||f.split('/').includes('..')))throw Error('HAPI_ARCHIVE_INVALID');
  run('tar',['-xzf',archive,'-C',archiveStage]);const newBinary=path.join(archiveStage,'package/bin/hapi');await fs.chmod(newBinary,0o700);
  if(!run(newBinary,['--version']).includes(release.hapi.version))throw Error('HAPI_VERSION_MISMATCH');
  // Upstream doctor extracts its own bundled tools (including tunwg) without opening a public Hub.
  phase='hapi-tools';run(newBinary,['doctor'],{env:{...env,HAPI_HOME:path.join(stage,'bootstrap-home')}});
  const tools=path.join(stage,'bootstrap-home/runtime',release.hapi.version,'tools/tunwg');if(!await exists(path.join(tools,'tunwg')))throw Error('TUNNEL_TOOL_MISSING');
  // Refuse in-place replacement while this installation is serving devices.
  phase='installation-ownership';const probe=await doctor(false);if(probe.checks.gatewayOwned?.ok||probe.checks.hubOwned?.ok)throw Error('STOP_THIS_CONNECTION_BEFORE_UPDATE');
  phase='install-files';const backup=path.join(base,'.previous-app');if(await exists(backup))await fs.rm(backup,{recursive:true});
  if(await exists(runtime))await fs.rename(runtime,backup);
  try{await fs.rename(appStage,runtime);}catch(e){if(await exists(backup))await fs.rename(backup,runtime);throw e;}
  await fs.mkdir(path.dirname(binary),{recursive:true,mode:0o700});await fs.copyFile(newBinary,binary);await fs.chmod(binary,0o700);
  const toolDest=path.join(hapi,'home/runtime',release.hapi.version,'tools/tunwg');await fs.mkdir(toolDest,{recursive:true,mode:0o700});await fs.cp(tools,toolDest,{recursive:true});await fs.chmod(path.join(toolDest,'tunwg'),0o700);
  await privateJson(path.join(base,'installation.json'),{version:release.version,hapiVersion:release.hapi.version,platform:release.platform,installedAt:new Date().toISOString(),binarySha256:await hash(binary),runtime});
  console.log(JSON.stringify({installed:true,version:release.version,stateDirectory:base,next:'start --project <absolute project path>',autostart:false,supervisor:false}));
 }finally{await fs.rm(stage,{recursive:true,force:true});}
}
async function health(url,timeout=2500){try{const r=await fetch(url,{signal:AbortSignal.timeout(timeout)});return {ok:r.ok,data:await r.json()};}catch{return {ok:false};}}
async function doctor(emit=true){
 const checks={node:{ok:Number(process.versions.node.split('.')[0])>=22,version:process.versions.node},platform:{ok:`${process.platform}-${process.arch}`===release.platform},runtime:{ok:await exists(path.join(runtime,'scripts/hapi-connect.mjs'))},hapiInstalled:{ok:await exists(binary)}};
 try{const require=createRequire(path.join(runtime,'package.json'));require.resolve('qrcode');require.resolve('ws');checks.dependencies={ok:true};}catch{checks.dependencies={ok:false};}
 if(checks.runtime.ok)try{await verifyRuntime(runtime);checks.runtimeIntegrity={ok:true};}catch{checks.runtimeIntegrity={ok:false};}
 if(checks.hapiInstalled.ok)try{const m=await json(path.join(base,'installation.json'));checks.hapiIntegrity={ok:await hash(binary)===m.binarySha256};}catch{checks.hapiIntegrity={ok:false};}
 const cmd=pid=>{try{return run('/bin/ps',['-p',String(pid),'-o','command=']).trim();}catch{return '';}};
 let info={};try{info=await json(path.join(gateway,'runtime.json'));}catch{}
 checks.gatewayOwned={ok:!!info.gatewayPid&&cmd(info.gatewayPid).endsWith(path.join(runtime,'scripts/hapi-connect.mjs')+' serve')};
 let hubPid;try{hubPid=(await json(path.join(hapi,'hub-pid.json'))).pid;}catch{}
 checks.hubOwned={ok:!!hubPid&&[`${binary} hub --no-relay`,`${binary} hub --relay`].includes(cmd(hubPid))};
 checks.hubHealth={ok:(await health(hubUrl+'/health')).ok};checks.gatewayHealth={ok:(await health(gatewayUrl+'/health')).data?.capabilities?.moecastGateway===1};
 checks.foreignPort={ok:!(checks.hubHealth.ok&&!checks.hubOwned.ok||checks.gatewayHealth.ok&&!checks.gatewayOwned.ok)};
 if(checks.hubOwned.ok)try{const settings=await json(path.join(hapi,'home/settings.json'));const r=await fetch(hubUrl+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:settings.cliApiToken}),signal:AbortSignal.timeout(3000)});const auth=await r.json();checks.hubAuth={ok:r.ok};if(r.ok){const machines=await (await fetch(hubUrl+'/api/machines',{headers:{Authorization:'Bearer '+auth.token},signal:AbortSignal.timeout(3000)})).json();checks.runner={ok:machines.machines?.some(m=>m.active)===true};
 const listed=await(await fetch(hubUrl+'/api/sessions',{headers:{Authorization:'Bearer '+auth.token},signal:AbortSignal.timeout(3000)})).json();const sessions=new Map((listed.sessions??[]).map(s=>[s.id,s]));let retained=0;
 const records=path.join(hapi,'home/codex-runtimes');for(const f of await fs.readdir(records).catch(()=>[])){if(!f.endsWith('.json'))continue;try{const record=await json(path.join(records,f));if(!cmd(record.pid).startsWith(binary+' codex '))continue;for(const id of Object.keys(record.sessions??{}))if(sessions.has(id)&&!sessions.get(id).active)retained++;}catch{}}
 checks.retainedSessionRuntimes={ok:retained===0,count:retained};
 } }catch{checks.hubAuth={ok:false};}
 let codex;for(const candidate of ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex','/Applications/Codex.app/Contents/Resources/codex',path.join(os.homedir(),'.local/bin/codex'),'codex'])try{const r=spawnSync(candidate,['login','status'],{env,encoding:'utf8',timeout:8000});if(!r.error){codex=candidate;checks.codexLogin={ok:r.status===0};break;}}catch{}
 checks.codexInstalled={ok:!!codex};
 if(info.origin&&/^https:\/\/[a-z0-9]+\.relay\.hapi\.run$/.test(info.origin))try{const r=JSON.parse(run('curl',['--fail','--silent','--max-time','5',info.origin+'/health'],{timeout:7000}));checks.publicHttps={ok:r.capabilities?.moecastGateway===1};}catch{checks.publicHttps={ok:false};}
 const report={checks,serviceReady:!!(checks.gatewayOwned.ok&&checks.hubOwned.ok&&checks.runner?.ok&&checks.publicHttps?.ok),autostart:false,supervisor:false,stateDirectory:base};if(emit)console.log(JSON.stringify(report,null,2));return report;
}
async function service(cmd,extra=args){
 if(!await exists(path.join(runtime,'scripts/hapi-connect.mjs')))throw Error('INSTALL_REQUIRED');
 if(['start','pair'].includes(cmd)){const d=await doctor(false);if(!d.checks.foreignPort.ok)throw Error('PORT_USED_BY_ANOTHER_INSTALLATION');if(!d.checks.runtimeIntegrity?.ok||!d.checks.hapiIntegrity?.ok)throw Error('INSTALLATION_INTEGRITY_FAILED');if(!d.checks.codexLogin?.ok)throw Error('CODEX_LOGIN_REQUIRED');}
 const r=spawnSync(process.execPath,[path.join(runtime,'scripts/hapi-connect.mjs'),cmd,...extra],{env,stdio:'inherit'});if(r.status!==0)throw Error('CONNECTION_COMMAND_FAILED');
}
try{
 if(command==='install')await install();
 else if(command==='doctor')await doctor();
 else if(command==='repair'){const d=await doctor(false);if(!d.checks.runtime.ok||!d.checks.hapiInstalled.ok||!d.checks.dependencies.ok)await install();await service('start',['--no-pair',...args]);const restored=await doctor(false);if(restored.checks.retainedSessionRuntimes?.ok===false)throw Error('EXISTING_EXECUTOR_REATTACH_REQUIRED');}
 else if(command==='stop'){await service('stop');run(process.execPath,[path.join(runtime,'scripts/hapi-lab.mjs'),'down']);console.log('Connection services stopped. Saved identity and computer tasks were retained.');}
 else if(command==='uninstall'){await service('stop');run(process.execPath,[path.join(runtime,'scripts/hapi-lab.mjs'),'down']);for(const folder of [runtime,path.join(base,'.previous-app'),path.join(hapi,'runtime'),path.join(hapi,'home/runtime')])await fs.rm(folder,{recursive:true,force:true});console.log('Program removed; saved identity and history retained. No startup registration exists.');}
 else if(['start','pair','status','devices','revoke'].includes(command))await service(command);
 else throw Error('USE_INSTALL_START_DOCTOR_REPAIR_PAIR_DEVICES_REVOKE_STOP_UNINSTALL');
}catch(e){console.error(JSON.stringify({ok:false,error:/^[A-Z0-9_]+$/.test(e.message)?e.message:typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'OPERATION_FAILED',phase,next:'Run doctor; do not clear pairing or create a new thread.'}));process.exitCode=1;}
