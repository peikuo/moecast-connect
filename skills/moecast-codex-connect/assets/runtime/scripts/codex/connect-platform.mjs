import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const supportedPlatforms = ['darwin-arm64', 'win32-x64'];
export const platformKey = (platform=process.platform, arch=process.arch) => `${platform}-${arch}`;
export function powershell(script, {env={}, run=execFileSync, ...options}={}) {
 return run('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "+script],
  {encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe'],...options,env:{...process.env,...env}}).trim();
}
export async function privateDirectory(directory, {platform=process.platform, run=execFileSync}={}) {
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 if(platform!=='win32'){await fs.chmod(directory,0o700);return;}
 const sid=powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',{run});
 if(!/^S-1-(?:\d+-)*\d+$/.test(sid))throw Error('WINDOWS_IDENTITY_UNAVAILABLE');
 run('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});
}
export function adminEndpoint(home, platform=process.platform) {
 if(platform!=='win32')return path.posix.join(home,'admin.sock');
 const key=createHash('sha256').update(path.win32.normalize(home).toLowerCase()).digest('hex').slice(0,32);
 return {path:`\\\\.\\pipe\\moecast-connect-${key}`,tokenFile:path.win32.join(home,'admin-token')};
}
/** Windows command-line decoding (backslashes before quotes follow CommandLineToArgvW). */
export function windowsArgs(command) {
 const args=[];let i=0;
 while(i<command.length){while(/\s/.test(command[i]??'')&&i<command.length)i++;if(i===command.length)break;
  let value='',quoted=false;
  while(i<command.length&&(quoted||!(/\s/.test(command[i])))){
   let slashes=0;while(command[i]==='\\'){slashes++;i++;}
   if(command[i]==='"'){value+='\\'.repeat(Math.floor(slashes/2));if(slashes%2)value+='"';else quoted=!quoted;i++;}
   else{value+='\\'.repeat(slashes);if(i<command.length){value+=command[i];i++;}}
  }args.push(value);
 }return args;
}
export function processInfo(pid, {platform=process.platform, run=execFileSync}={}) {
 if(!Number.isSafeInteger(pid)||pid<=0)return null;
 try{
  if(platform==='win32'){
   const text=powershell('$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:MOECAST_QUERY_PID); if($p){@{executable=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress}',{run,env:{MOECAST_QUERY_PID:String(pid)}});
   return text?JSON.parse(text):null;
  }
  const command=run('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
  return command?{command}:null;
 }catch{return null;}
}
export function ownsProcess(pid, executable, args=[], options={}) {
 const platform=options.platform??process.platform,info=processInfo(pid,options);if(!info)return false;
 if(platform==='win32'){
  const norm=p=>typeof p==='string'?path.win32.normalize(p).toLowerCase():'';
  if(norm(info.executable)!==norm(executable))return false;
  const actual=windowsArgs(info.command??'').slice(1);
  return args.length===0||actual.length===args.length&&args.every((arg,i)=>norm(actual[i])===norm(arg));
 }
 return args.length?info.command===`${executable} ${args.join(' ')}`:info.command.startsWith(executable+' ');
}
export function listeningPids(port, {platform=process.platform, run=execFileSync}={}) {
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('INVALID_PORT');
 if(platform==='win32'){
  const text=powershell('Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -eq [int]$env:MOECAST_QUERY_PORT} | Select-Object -ExpandProperty OwningProcess -Unique',{run,env:{MOECAST_QUERY_PORT:String(port)}});
  return text?text.split(/\s+/).map(Number):[];
 }
 try{return run('lsof',['-t','-nP',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim().split(/\s+/).filter(Boolean).map(Number);}
 catch(e){if(e.status===1&&!e.stdout?.toString().trim())return [];throw e;}
}
export function desktopRunning({platform=process.platform,run=execFileSync}={}) {
 if(platform==='win32')return powershell("[bool](Get-Process -Name Codex -ErrorAction SilentlyContinue | Where-Object {$_.Path})",{run}).toLowerCase()==='true';
 if(platform==='darwin')return run('/usr/bin/osascript',['-e','application id "com.openai.codex" is running'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim()==='true';
 return false;
}
export async function windowsCodexPaths({env=process.env, run=execFileSync}={}) {
 const candidates=[];
 if(env.LOCALAPPDATA)candidates.push(path.win32.join(env.LOCALAPPDATA,'OpenAI','Codex','bin','codex.exe'));
 try{
  const text=powershell("$roots=@(Get-Process -Name Codex -ErrorAction SilentlyContinue | ForEach-Object {Split-Path $_.Path}); $roots+=@(Get-AppxPackage -Name '*Codex*' | Select-Object -ExpandProperty InstallLocation); ConvertTo-Json -Compress -InputObject @($roots | Where-Object {$_} | Select-Object -Unique)",{run});
  for(const dir of JSON.parse(text||'[]'))for(const suffix of ['resources\\codex.exe','app\\resources\\codex.exe'])candidates.push(path.win32.join(dir,suffix));
 }catch{ /* PATH and explicit executable selection remain available. */ }
 return candidates;
}
export async function npmInvocation({platform=process.platform,env=process.env,executable=process.execPath}={}) {
 if(platform!=='win32')return {file:'npm',args:[]};
 const dirs=[path.win32.dirname(executable),...(env.PATH??'').split(';').filter(Boolean),...(env.APPDATA?[path.win32.join(env.APPDATA,'npm')]:[])];
 const candidates=[env.npm_execpath,...dirs.map(dir=>path.win32.join(dir,'node_modules','npm','bin','npm-cli.js'))].filter(Boolean);
 for(const candidate of candidates)if(path.win32.isAbsolute(candidate)&&await fs.stat(candidate).then(s=>s.isFile(),()=>false))return {file:executable,args:[candidate]};
 throw Error('NPM_NOT_INSTALLED');
}
export const curlExecutable = (platform=process.platform) => platform==='win32'?'curl.exe':'curl';
