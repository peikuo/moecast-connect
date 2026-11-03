import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fault,isId} from './hapi-device-store.mjs';
const execute=promisify(execFile);
const windowsScript=script=>"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "+script;

/** Plain user-message delivery to one bound desktop chat. No model tools or target routing. */
export class DesktopThreadInbox {
 constructor({codex,threadId,run=execute,platform=process.platform}){
  if(!isId(threadId))throw fault('INVALID_FRONTDESK_BINDING');
  Object.assign(this,{codex,threadId,run,platform});
 }
 async available(){
  if(this.platform==='win32'){
   const result=await this.run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',windowsScript("[bool](Get-Process -Name Codex -ErrorAction SilentlyContinue | Where-Object {$_.Path})")],{timeout:10000,windowsHide:true});
   if(result.stdout.trim().toLowerCase()!=='true')throw fault('DESKTOP_INBOX_OFFLINE',503);return;
  }
  if(this.platform!=='darwin')throw fault('DESKTOP_INBOX_UNAVAILABLE',503);
  const result=await this.run('/usr/bin/osascript',['-e','application id "com.openai.codex" is running'],{timeout:5000});
  if(result.stdout.trim()!=='true')throw fault('DESKTOP_INBOX_OFFLINE',503);
 }
 async open(){
  await this.available();
  await this.wake();
 }
 async wake(){
  if(this.platform==='win32'){
   await this.run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',windowsScript('Start-Process -FilePath $env:MOECAST_DESKTOP_URI')],{timeout:10000,windowsHide:true,env:{...process.env,MOECAST_DESKTOP_URI:`codex://threads/wake/${this.threadId}`}});return;
  }
  await this.run('/usr/bin/open',['-g','-b','com.openai.codex',`codex://threads/wake/${this.threadId}`],{timeout:10000});
 }
 async send({text,locale='zh-CN',localId,onAttempt=async()=>{}}){
  if(typeof text!=='string'||!text.trim()||text.length>8000||!isId(localId))throw fault('INVALID_ASSISTANT_REQUEST');
  if(!['zh-CN','en-US'].includes(locale))throw fault('INVALID_LOCALE');
  await this.available();
  await this.codex.rpc('thread/queue/list',{threadId:this.threadId,limit:1});
  await onAttempt();
  const result=await this.codex.rpc('thread/queue/add',{threadId:this.threadId,clientUserMessageId:localId,input:[{type:'text',text:locale==='en-US'?'Message from MoeCast. Reply in English by default; follow any language the user explicitly requests.':'消息来自 MoeCast。默认用中文回复；用户明确指定其他语言时遵从用户请求。'},{type:'text',text}]});
  if(result.queuedSubmission?.clientUserMessageId!==localId||!isId(result.queuedSubmission?.id))throw fault('DESKTOP_INBOX_UNCONFIRMED',502);
  // Existing desktop owns loading and execution. Never resume/start on the gateway reader.
  await this.wake();
  return {queuedSubmissionId:result.queuedSubmission.id};
 }
}
