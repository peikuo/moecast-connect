// Local operator control for the device gateway. No owner credential leaves this host.
import fs from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DeviceStore,atomicJson,commonProjectRoot} from './desktop/hapi-device-store.mjs';
import {DeviceGateway,adminRequest} from './desktop/hapi-gateway.mjs';
import {hubPort,gatewayPort,hubUrl,gatewayUrl} from './desktop/hapi-ports.mjs';
import {DeviceAssistant} from './desktop/hapi-assistant.mjs';
import {AssistantModel} from './desktop/hapi-assistant-model.mjs';
import {RetainedExecutors} from './desktop/hapi-executors.mjs';
import {CodexDirectory,HapiOwner,ThreadDirectory} from './desktop/hapi-directory.mjs';
const root=path.resolve(import.meta.dirname,'..');
const patchedTunnel=path.join(root,'scripts/connect/tunwg/tunwg');
async function verifiedTunnel(){
 const manifest=JSON.parse(await fs.readFile(path.join(root,'scripts/connect/tunwg/build-manifest.json'),'utf8'));
 if(createHash('sha256').update(await fs.readFile(patchedTunnel)).digest('hex')!==manifest.binarySha256)throw Error('TUNNEL_INTEGRITY_MISMATCH');
 return patchedTunnel;
}
const stateRoot=process.env.MOECAST_CONNECT_HOME?path.resolve(process.env.MOECAST_CONNECT_HOME):undefined;
const home=stateRoot?path.join(stateRoot,'gateway'):path.join(root,'.native-cache/hapi-gateway');
const lab=stateRoot?path.join(stateRoot,'hapi'):path.join(root,'.native-cache/hapi-lab');
const socket=path.join(home,'admin.sock'),infoFile=path.join(home,'runtime.json');
const args=process.argv.slice(2);const command=args[0]&&!args[0].startsWith('--')?args.shift():'start';
const values=key=>args.flatMap((s,i)=>s===key?[args[i+1]]:[]);
await fs.mkdir(home,{recursive:true,mode:0o700});await fs.chmod(home,0o700);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await pause(300);}throw Error(label);}
const readInfo=async()=>JSON.parse(await fs.readFile(infoFile,'utf8'));
function proxyEnvironment(){
 const env={...process.env,NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1'};
 if(!env.HTTPS_PROXY&&!env.https_proxy&&process.platform==='darwin')try{
  const config=execFileSync('scutil',['--proxy'],{encoding:'utf8'});
  const host=config.match(/HTTPSProxy : ([^\s]+)/)?.[1],port=config.match(/HTTPSPort : (\d+)/)?.[1];
  if(/HTTPSEnable : 1/.test(config)&&host&&port){env.HTTPS_PROXY=`http://${host}:${port}`;env.HTTP_PROXY=env.HTTPS_PROXY;}
 }catch{}
 return env;
}
async function relaySettings(refresh=false){
 const file=path.join(lab,'home/settings.json');let settings=JSON.parse(await fs.readFile(file,'utf8'));
 if(!settings.relayAuthKey||refresh){
  let issued;try{issued=JSON.parse(execFileSync('curl',['--fail','--silent','--max-time','12','--request','POST','https://relay.hapi.run/issue'],{encoding:'utf8',env:proxyEnvironment(),stdio:['ignore','pipe','ignore'],timeout:15000}));}catch{throw Error('RELAY_KEY_ISSUANCE_UNAVAILABLE');}
  if(typeof issued.key!=='string'||!issued.key||issued.key.length>4096)throw Error('RELAY_KEY_RESPONSE_INVALID');
  settings=JSON.parse(await fs.readFile(file,'utf8'));settings.relayAuthKey=issued.key;await atomicJson(file,settings);
 }return settings;
}
async function verifyHttps(info,ms=600000){
 await wait(async()=>{try{const result=execFileSync('curl',['--fail','--silent','--connect-timeout','4','--max-time','20',info.origin+'/health'],{encoding:'utf8',env:proxyEnvironment(),stdio:['ignore','pipe','ignore'],timeout:22000});return JSON.parse(result).capabilities?.moecastGateway===1;}catch{return false;}},'TRUSTED_HTTPS_NOT_READY',ms);
}

const processCommand=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();}catch{return'';}};
async function serve(){
 const settings=JSON.parse(await fs.readFile(path.join(lab,'home/settings.json'),'utf8'));
 const owner=new HapiOwner({root:path.join(home,'owner-client'),url:hubUrl,token:settings.cliApiToken});
 const {machines}=await owner.json('/api/machines');const machine=machines.find(m=>m.active);if(!machine)throw Error('RUNNER_OFFLINE');
 const codex=new CodexDirectory(path.join(home,'directory-reader'));await codex.client.connect();
 const store=new DeviceStore(path.join(home,'devices.json'));await store.load();
 const executors=new RetainedExecutors({home:path.join(lab,'home'),url:hubUrl,token:settings.cliApiToken,executable:path.join(lab,'runtime/package/bin/hapi'),owner});
 const directory=new ThreadDirectory({codex,hapi:owner,machineId:machine.id,executors});const gateway=new DeviceGateway({store,directory,hapi:owner});gateway.assistant=new DeviceAssistant({store,directory,model:new AssistantModel(path.join(home,'assistant-model')),gateway});await gateway.listen(gatewayPort);await gateway.admin(socket);
 const stop=async()=>{await gateway.close();owner.close();codex.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 console.log('MoeCast device gateway ready (loopback).');
}
async function selectedProjects(){
 let projects=values('--project');
 if(!projects.length)try{projects=JSON.parse(await fs.readFile(path.join(home,'projects.json'),'utf8')).projects;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!projects?.length)projects=[stateRoot?process.cwd():root];
 const selected=[...new Set(await Promise.all(projects.map(p=>fs.realpath(path.resolve(p)))))];
 if(selected.includes(path.parse(selected[0]).root))throw Error('PROJECT_ROOT_TOO_BROAD');
 await atomicJson(path.join(home,'projects.json'),{projects:selected});return selected;
}
async function ensurePrivateHub(){
 const executable=path.join(lab,'runtime/package/bin/hapi');
 await fs.access(executable);
 const projects=await selectedProjects();
 try{const devices=JSON.parse(await fs.readFile(path.join(home,'devices.json'),'utf8')).devices;for(const d of Object.values(devices))if(!d.revokedAt&&d.grants?.capabilities?.includes('dispatch'))projects.push(...d.grants.projects);}catch(error){if(error.code!=='ENOENT')throw error;}
 const runnerRoot=commonProjectRoot([...new Set(projects)]);
 let pid;try{pid=JSON.parse(await fs.readFile(path.join(lab,'hub-pid.json'),'utf8')).pid;}catch{}
 if(pid){const cmd=processCommand(pid);if(cmd===`${executable} hub --relay`){process.kill(pid,'SIGTERM');await wait(async()=>!processCommand(pid),'OLD_HUB_STOP_TIMEOUT');}}
 // Remove only the isolated lab's old owner-forwarding tunnel, including an orphan.
 const processes=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n');
 const tunwg=path.join(lab,'home/runtime/0.30.7/tools/tunwg/tunwg');
 for(const line of processes){const match=line.trim().match(/^(\d+) (.+)$/);if(match&&match[2].startsWith(tunwg+' ')&&match[2].includes(`--forward=http://localhost:${hubPort}`))process.kill(Number(match[1]),'SIGTERM');}
 let previous;try{previous=JSON.parse(await fs.readFile(path.join(lab,'runtime-manifest.json'),'utf8'));}catch{}
 if(previous&&(previous.runnerRoot||previous.directory)!==runnerRoot)execFileSync(executable,['runner','stop'],{cwd:root,env:{...process.env,HAPI_HOME:path.join(lab,'home')},stdio:'ignore',timeout:15000});
 execFileSync(process.execPath,[path.join(root,'scripts/hapi-lab.mjs'),'up'],{cwd:root,env:{...process.env,MOECAST_HAPI_RELAY:'0',MOECAST_HAPI_LAN_HOST:'',MOECAST_HAPI_WORKSPACE_ROOT:runnerRoot},stdio:'ignore',timeout:45000});
 const listeners=execFileSync('lsof',['-nP',`-iTCP:${hubPort}`,'-sTCP:LISTEN'],{encoding:'utf8'});
 if(!listeners.includes(`127.0.0.1:${hubPort}`)||listeners.includes(`*:${hubPort}`))throw Error('HUB_MUST_BE_LOOPBACK_ONLY');
}
async function recoverExecutors(){
 const settings=JSON.parse(await fs.readFile(path.join(lab,'home/settings.json'),'utf8'));
 const owner=new HapiOwner({root:path.join(home,'recovery-client'),url:hubUrl,token:settings.cliApiToken});
 try{return await new RetainedExecutors({home:path.join(lab,'home'),url:hubUrl,token:settings.cliApiToken,executable:path.join(lab,'runtime/package/bin/hapi'),owner}).recoverAll();}finally{owner.close();}
}
async function start(recoveredAuth=false){
 await ensurePrivateHub();const executorRecovery=await recoverExecutors();if(executorRecovery.unresolved.length)console.error(JSON.stringify({event:'executor_recovery_pending',sessions:executorRecovery.unresolved}));let alive=false;
 try{await adminRequest(socket,{action:'devices'});alive=true;}catch{}
 let info;try{info=await readInfo();}catch{info={};}
 if(alive&&args.includes('--restart-gateway')){if(!processCommand(info.gatewayPid).endsWith('scripts/hapi-connect.mjs serve'))throw Error('GATEWAY_PID_MISMATCH');process.kill(info.gatewayPid,'SIGTERM');await wait(async()=>!processCommand(info.gatewayPid),'GATEWAY_STOP_TIMEOUT');alive=false;}
 if(!alive){
  const log=openSync(path.join(home,'gateway.log'),'a',0o600);
  const child=spawn(process.execPath,[path.join(root,'scripts/hapi-connect.mjs'),'serve'],{cwd:root,detached:true,stdio:['ignore',log,log]});child.unref();closeSync(log);info.gatewayPid=child.pid;
  await wait(async()=>{try{await adminRequest(socket,{action:'devices'});return true;}catch{return false;}},'GATEWAY_START_FAILED');
 }
 const tunwg=await verifiedTunnel(),ownsTunnel=pid=>[tunwg,path.join(lab,'home/runtime/0.30.7/tools/tunwg/tunwg')].some(file=>processCommand(pid).startsWith(file+' '));
 if(args.includes('--restart-tunnel')&&ownsTunnel(info.tunnelPid)){process.kill(info.tunnelPid,'SIGTERM');await wait(async()=>!processCommand(info.tunnelPid),'TUNNEL_STOP_TIMEOUT');info.origin=undefined;}
 if(!info.origin||!ownsTunnel(info.tunnelPid)){
  const settings=await relaySettings();
  const logfile=path.join(home,'tunnel.log');let offset=0;try{offset=(await fs.stat(logfile)).size;}catch{}
  const log=openSync(logfile,'a',0o600);
  const child=spawn(tunwg,['--json',args.includes('--debug-tunnel')?'--log_level=-4':'--log_level=0',`--forward=${gatewayUrl}`],{cwd:home,detached:true,stdio:['ignore',log,log],env:{...Object.fromEntries(Object.entries(proxyEnvironment()).filter(([key])=>['PATH','HOME','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'].includes(key))),TUNWG_PATH:path.join(home,'tunnel'),TUNWG_API:'relay.hapi.run',TUNWG_AUTH:settings.relayAuthKey,...(args.includes('--udp')?{}:{TUNWG_RELAY:'true'})}});child.unref();closeSync(log);info.tunnelPid=child.pid;
  try{
   info.origin=await wait(async()=>{const text=(await fs.readFile(logfile,'utf8')).slice(offset);for(const line of text.split('\n')){let r;try{r=JSON.parse(line);}catch{continue;}if(r.event==='peer_registration_rejected'&&r.status===403)throw Error('RELAY_AUTH_REJECTED');if(r.msg==='listener started'&&/^https:\/\//.test(r.url))return r.url.replace(/\/$/,'');}return false;},'TUNNEL_START_FAILED',60000);
  }catch(error){if(error.message==='RELAY_AUTH_REJECTED'&&!recoveredAuth){if(processCommand(child.pid).startsWith(tunwg+' '))process.kill(child.pid,'SIGTERM');await relaySettings(true);return start(true);}throw error;}
  info.transport=args.includes('--udp')?'udp':'tcp';
 }
 await atomicJson(infoFile,info);
 await verifyHttps(info);info.verifiedAt=new Date().toISOString();info.executorRecovery=executorRecovery;await atomicJson(infoFile,info);
 return info;
}
async function pair(info){
 const projects=await selectedProjects();
 const result=await adminRequest(socket,{action:'pair',name:values('--name')[0]||'我的手机',grants:{projects,threadIds:values('--thread'),capabilities:args.includes('--read-only')?['read']:['read','dispatch']}});
 const payload={type:'moecast-pairing-v1',url:info.origin,hubId:result.hubId,code:result.code,expiresAt:result.expiresAt};
 const file=path.join(home,'pairing.json');await atomicJson(file,payload);
 const {default:QRCode}=await import('qrcode');const svg=await QRCode.toString(JSON.stringify(payload),{type:'svg',errorCorrectionLevel:'M',margin:4});await fs.writeFile(path.join(home,'pairing.svg'),svg,{mode:0o600});
 await QRCode.toFile(path.join(home,'pairing.png'),JSON.stringify(payload),{width:640,errorCorrectionLevel:'M',margin:4});await fs.chmod(path.join(home,'pairing.png'),0o600);
 console.log(JSON.stringify({ready:true,message:'电脑已准备好。手机扫码连接；二维码两分钟内有效，只能使用一次。',projects,permission:args.includes('--read-only')?'只查看':'查看与派活',pairingFile:file,qrFile:path.join(home,'pairing.svg'),qrPngFile:path.join(home,'pairing.png'),expiresAt:result.expiresAt},null,2));
}
try{
 if(command==='serve')await serve();
 else if(command==='start'){const info=await start();if(args.includes('--no-pair'))console.log(JSON.stringify({ready:true,origin:info.origin,message:'连接已恢复，手机可使用已保存授权重连。'}));else await pair(info);}
 else if(command==='pair'){const info=await readInfo();await verifyHttps(info,15000);await pair(info);}
 else if(command==='recover-executors')console.log(JSON.stringify({recovered:await recoverExecutors()}));
 else if(command==='devices')console.log(JSON.stringify(await adminRequest(socket,{action:'devices'}),null,2));
 else if(command==='revoke'){const id=args[0];if(!id)throw Error('DEVICE_ID_REQUIRED');console.log(JSON.stringify(await adminRequest(socket,{action:'revoke',id}),null,2));}
 else if(command==='status'){const info=await readInfo();console.log(JSON.stringify({origin:info.origin,devices:await adminRequest(socket,{action:'devices'})},null,2));}
 else if(command==='stop'){
  const info=await readInfo();
  const binaries=[patchedTunnel,path.join(lab,'home/runtime/0.30.7/tools/tunwg/tunwg')];
  if(binaries.some(file=>processCommand(info.tunnelPid).startsWith(file+' ')))process.kill(info.tunnelPid,'SIGTERM');
  if(processCommand(info.gatewayPid).endsWith('scripts/hapi-connect.mjs serve'))process.kill(info.gatewayPid,'SIGTERM');
  console.log('Phone gateway stopped. Computer tasks and saved pairing remain.');
 }
 else throw Error('Use start|pair|devices|revoke <device-id>|status|stop');
}catch(error){console.error('MoeCast connection: '+(error.message?.match(/^[A-Z_]+$/)?error.message:'SETUP_FAILED (see private gateway log)'));process.exitCode=1;}
