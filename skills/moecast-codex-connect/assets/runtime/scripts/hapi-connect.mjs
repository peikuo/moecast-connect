import {adminEndpoint,privateDirectory,processInfo,ownsProcess,curlExecutable} from './codex/connect-platform.mjs';
// Local operator control for the device gateway. No owner credential leaves this host.
import fs from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DeviceStore,atomicJson} from './codex/hapi-device-store.mjs';
import {DeviceGateway,adminRequest} from './codex/hapi-gateway.mjs';
import {gatewayPort,gatewayUrl} from './codex/hapi-ports.mjs';
import {computerIdentity} from './codex/computer-identity.mjs';
import {AssistantModel} from './codex/hapi-assistant-model.mjs';
import {FixedHapiAssistant} from './codex/hapi-fixed-assistant.mjs';
import {DesktopThreadInbox} from './codex/desktop-thread-inbox.mjs';
import {CodexDirectory,ThreadDirectory} from './codex/hapi-directory.mjs';
const root=path.resolve(import.meta.dirname,'..');
const tunnelDirectory=path.join(root,'scripts/connect/tunwg',...(process.platform==='win32'?['win32-x64']:[]));
const patchedTunnel=path.join(tunnelDirectory,process.platform==='win32'?'tunwg.exe':'tunwg');
async function verifiedTunnel(){
 const manifest=JSON.parse(await fs.readFile(path.join(tunnelDirectory,'build-manifest.json'),'utf8'));
 if(createHash('sha256').update(await fs.readFile(patchedTunnel)).digest('hex')!==manifest.binarySha256)throw Error('TUNNEL_INTEGRITY_MISMATCH');
 return patchedTunnel;
}
const stateRoot=process.env.MOECAST_CONNECT_HOME?path.resolve(process.env.MOECAST_CONNECT_HOME):undefined;
const home=stateRoot?path.join(stateRoot,'gateway'):path.join(root,'.native-cache/hapi-gateway');
const lab=stateRoot?path.join(stateRoot,'hapi'):path.join(root,'.native-cache/hapi-lab');
const socket=adminEndpoint(home),infoFile=path.join(home,'runtime.json');
const args=process.argv.slice(2);const command=args[0]&&!args[0].startsWith('--')?args.shift():'start';
const values=key=>args.flatMap((s,i)=>s===key?[args[i+1]]:[]);
await privateDirectory(home);
if(process.platform==='win32')await privateDirectory(lab);
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
 const file=path.join(lab,'home/settings.json');let settings;
 try{settings=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;settings={};}
 if(!settings.relayAuthKey||refresh){
  let issued;try{issued=JSON.parse(execFileSync(curlExecutable(),['--fail','--silent','--max-time','12','--request','POST','https://relay.hapi.run/issue'],{encoding:'utf8',env:proxyEnvironment(),stdio:['ignore','pipe','ignore'],timeout:15000}));}catch{throw Error('RELAY_KEY_ISSUANCE_UNAVAILABLE');}
  if(typeof issued.key!=='string'||!issued.key||issued.key.length>4096)throw Error('RELAY_KEY_RESPONSE_INVALID');
  settings.relayAuthKey=issued.key;await atomicJson(file,settings);
 }return settings;
}
async function verifyHttps(info,ms=600000){
 await wait(async()=>{try{const result=execFileSync(curlExecutable(),['--fail','--silent','--connect-timeout','4','--max-time','20',info.origin+'/health'],{encoding:'utf8',env:proxyEnvironment(),stdio:['ignore','pipe','ignore'],timeout:22000});return JSON.parse(result).capabilities?.moecastGateway===1;}catch{return false;}},'TRUSTED_HTTPS_NOT_READY',ms);
}

const processCommand=pid=>processInfo(pid)?.command??'';
const ownsGateway=pid=>ownsProcess(pid,process.execPath,[path.join(root,'scripts/hapi-connect.mjs'),'serve']);
async function serve(){
 const store=new DeviceStore(path.join(home,'devices.json'));await store.load();
 const machineId=await computerIdentity(home,store.data);
 const codex=new CodexDirectory(path.join(home,'directory-reader'));await codex.client.connect();
 const directory=new ThreadDirectory({codex,machineId});const gateway=new DeviceGateway({store,directory});gateway.assistant=new FixedHapiAssistant({store,directory,model:new AssistantModel(path.join(home,'assistant-model')),desktopInbox:threadId=>new DesktopThreadInbox({codex,threadId}),prepareAttachments:(deviceId,requestId)=>gateway.artifacts.prepareNative(deviceId,requestId)});await gateway.listen(gatewayPort);await gateway.admin(socket);
 const stop=async()=>{await gateway.close();codex.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 console.log('MoeCast device gateway ready (loopback).');
}
async function start(recoveredAuth=false){
 let alive=false;
 try{await adminRequest(socket,{action:'devices'});alive=true;}catch{}
 let info;try{info=await readInfo();}catch{info={};}
 if(alive&&!ownsGateway(info.gatewayPid))throw Error('GATEWAY_PID_MISMATCH');
 if(alive&&args.includes('--restart-gateway')){if(!ownsGateway(info.gatewayPid))throw Error('GATEWAY_PID_MISMATCH');process.kill(info.gatewayPid,'SIGTERM');await wait(async()=>!processCommand(info.gatewayPid),'GATEWAY_STOP_TIMEOUT');alive=false;}
 if(!alive){
  const log=openSync(path.join(home,'gateway.log'),'a',0o600);
  const child=spawn(process.execPath,[path.join(root,'scripts/hapi-connect.mjs'),'serve'],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log]});child.unref();closeSync(log);info.gatewayPid=child.pid;await atomicJson(infoFile,info);
  await wait(async()=>{try{await adminRequest(socket,{action:'devices'});return true;}catch{return false;}},'GATEWAY_START_FAILED');
 }
 const tunwg=await verifiedTunnel(),ownsTunnel=pid=>ownsProcess(pid,tunwg);
 if(args.includes('--restart-tunnel')&&ownsTunnel(info.tunnelPid)){process.kill(info.tunnelPid,'SIGTERM');await wait(async()=>!processCommand(info.tunnelPid),'TUNNEL_STOP_TIMEOUT');info.origin=undefined;}
 if(!info.origin||!ownsTunnel(info.tunnelPid)){
  if(ownsTunnel(info.tunnelPid)){process.kill(info.tunnelPid,'SIGTERM');await wait(async()=>!processCommand(info.tunnelPid),'TUNNEL_STOP_TIMEOUT');}
  const settings=await relaySettings();
  const logfile=path.join(home,'tunnel.log');let offset=0;try{offset=(await fs.stat(logfile)).size;}catch{}
  const log=openSync(logfile,'a',0o600);
  const child=spawn(tunwg,['--json',args.includes('--debug-tunnel')?'--log_level=-4':'--log_level=0',`--forward=${gatewayUrl}`],{cwd:home,detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...Object.fromEntries(Object.entries(proxyEnvironment()).filter(([key])=>['PATH','HOME','USERPROFILE','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].includes(key.toUpperCase()))),TUNWG_PATH:path.join(home,'tunnel'),TUNWG_API:'relay.hapi.run',TUNWG_AUTH:settings.relayAuthKey,...(args.includes('--udp')?{}:{TUNWG_RELAY:'true'})}});child.unref();closeSync(log);info.tunnelPid=child.pid;delete info.origin;await atomicJson(infoFile,info);
  try{
   info.origin=await wait(async()=>{const text=(await fs.readFile(logfile,'utf8')).slice(offset);for(const line of text.split('\n')){let r;try{r=JSON.parse(line);}catch{continue;}if(r.event==='peer_registration_rejected'&&r.status===403)throw Error('RELAY_AUTH_REJECTED');if(r.msg==='listener started'&&/^https:\/\//.test(r.url))return r.url.replace(/\/$/,'');}return false;},'TUNNEL_START_FAILED',60000);
  }catch(error){if(error.message==='RELAY_AUTH_REJECTED'&&!recoveredAuth){if(ownsProcess(child.pid,tunwg)){process.kill(child.pid,'SIGTERM');await wait(async()=>!processCommand(child.pid),'TUNNEL_STOP_TIMEOUT');}await relaySettings(true);return start(true);}throw error;}
  info.transport=args.includes('--udp')?'udp':'tcp';
 }
 await atomicJson(infoFile,info);
 await verifyHttps(info);info.verifiedAt=new Date().toISOString();await atomicJson(infoFile,info);
 return info;
}
async function pair(info){
 const selected=values('--thread');if(selected.length>1)throw Error('ONE_FIXED_THREAD_REQUIRED');
 const threadId=selected[0]||process.env.CODEX_THREAD_ID||info.frontdeskThreadId;
 if(!threadId)throw Error('FIXED_FRONTDESK_REQUIRED');
 const result=await adminRequest(socket,{action:'pair',frontdeskThreadId:threadId,name:values('--name')[0]||'我的手机',grants:{capabilities:args.includes('--read-only')?['read']:['read','dispatch']}});
 info.frontdeskThreadId=threadId;await atomicJson(infoFile,info);
 const payload={type:'moecast-pairing-v1',url:info.origin,hubId:result.hubId,code:result.code,expiresAt:result.expiresAt};
 const file=path.join(home,'pairing.json');await atomicJson(file,payload);
 const {default:QRCode}=await import('qrcode');const svg=await QRCode.toString(JSON.stringify(payload),{type:'svg',errorCorrectionLevel:'M',margin:4});await fs.writeFile(path.join(home,'pairing.svg'),svg,{mode:0o600});
 await QRCode.toFile(path.join(home,'pairing.png'),JSON.stringify(payload),{width:640,errorCorrectionLevel:'M',margin:4});await fs.chmod(path.join(home,'pairing.png'),0o600);
 console.log(JSON.stringify({ready:true,message:'电脑已准备好。手机扫码连接；二维码两分钟内有效，只能使用一次。',scope:'computer',permission:args.includes('--read-only')?'只查看':'查看与派活',pairingFile:file,qrFile:path.join(home,'pairing.svg'),qrPngFile:path.join(home,'pairing.png'),expiresAt:result.expiresAt},null,2));
}
try{
 if(command==='serve')await serve();
 else if(command==='start'){const info=await start();if(args.includes('--no-pair'))console.log(JSON.stringify({ready:true,origin:info.origin,message:'连接已恢复，手机可使用已保存授权重连。'}));else await pair(info);}
 else if(command==='pair'){const info=await readInfo();await verifyHttps(info,15000);await pair(info);}
 else if(command==='devices')console.log(JSON.stringify(await adminRequest(socket,{action:'devices'}),null,2));
 else if(command==='deliver')console.log(JSON.stringify(await adminRequest(socket,{action:'deliver',deviceId:values('--device')[0],requestId:values('--request')[0],sourceMessageId:values('--message')[0],file:values('--file')[0],...(args.includes('--authorize-file')?{authorizeFile:true}:{})}),null,2));
 else if(command==='revoke'){const id=args[0];if(!id)throw Error('DEVICE_ID_REQUIRED');console.log(JSON.stringify(await adminRequest(socket,{action:'revoke',id}),null,2));}
 else if(command==='status'){const info=await readInfo();console.log(JSON.stringify({origin:info.origin,devices:await adminRequest(socket,{action:'devices'})},null,2));}
 else if(command==='stop'){
  const info=await readInfo().catch(error=>{if(error.code==='ENOENT')return {};throw error;});
  const tunnelCommand=processCommand(info.tunnelPid),gatewayCommand=processCommand(info.gatewayPid);
  if(tunnelCommand&&!ownsProcess(info.tunnelPid,patchedTunnel))throw Error('TUNNEL_PID_MISMATCH');
  if(gatewayCommand&&!ownsGateway(info.gatewayPid))throw Error('GATEWAY_PID_MISMATCH');
  if(tunnelCommand)process.kill(info.tunnelPid,'SIGTERM');
  if(gatewayCommand)process.kill(info.gatewayPid,'SIGTERM');
  console.log('Phone gateway stopped. Computer tasks and saved pairing remain.');
 }
 else throw Error('Use start|pair|devices|revoke <device-id>|status|stop');
}catch(error){console.error('MoeCast connection: '+(error.message?.match(/^[A-Z_]+$/)?error.message:'SETUP_FAILED (see private gateway log)'));process.exitCode=1;}
