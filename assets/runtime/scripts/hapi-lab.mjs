// Developer-only launcher. Runs unmodified upstream HAPI, never bundled in MoeCast.
import fs from 'node:fs/promises';
import {hubPort,hubUrl} from './desktop/hapi-ports.mjs';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lab = process.env.MOECAST_CONNECT_HOME ? path.join(path.resolve(process.env.MOECAST_CONNECT_HOME), 'hapi') : path.join(root, '.native-cache/hapi-lab');
const home = path.join(lab, 'home');
const directory = path.join(lab, 'chat-workspace');
const runnerRoot = process.env.MOECAST_HAPI_WORKSPACE_ROOT ? await fs.realpath(path.resolve(process.env.MOECAST_HAPI_WORKSPACE_ROOT)) : directory;
const executable = path.join(lab, 'runtime/package/bin/hapi');
const url = hubUrl;
const command = process.argv[2] || 'status';
const relay = process.env.MOECAST_HAPI_RELAY === '1';
const relayFlag = relay ? '--relay' : '--no-relay';
const lanHost = process.env.MOECAST_HAPI_LAN_HOST;
if (lanHost && !/^192\.168\.\d{1,3}\.\d{1,3}$/.test(lanHost)) throw Error('Lab LAN host must be a private 192.168.x.x address.');
await fs.mkdir(lab, { recursive: true, mode: 0o700 });
await fs.chmod(lab, 0o700);
await fs.mkdir(home, { recursive: true, mode: 0o700 });
await fs.mkdir(directory, { recursive: true });
const settingsPath = path.join(home, 'settings.json');
let settings;
try { settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  settings = { cliApiToken: randomBytes(32).toString('base64url'), apiUrl: url };
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
await fs.chmod(settingsPath, 0o600);
const env = { ...process.env, HAPI_HOME: home, HAPI_API_URL: url, HAPI_LISTEN_HOST: lanHost ? '0.0.0.0' : '127.0.0.1', HAPI_LISTEN_PORT: String(hubPort),
  CLI_API_TOKEN: settings.cliApiToken, HAPI_ANDROID_PUSH: 'off', HAPI_IOS_PUSH: 'off', TELEGRAM_NOTIFICATION: 'false', SERVERCHAN_NOTIFICATION: 'false' };
if (lanHost && !relay) env.HAPI_PUBLIC_URL = `http://${lanHost}:${hubPort}`;
// This lab enables no title, voice, notification or relay provider.
for (const key of Object.keys(env)) if (/^(HAPI_TITLE_PROVIDER_|TELEGRAM_BOT_TOKEN$|SERVERCHAN_SENDKEY$|ELEVENLABS_|OPENAI_API_KEY$|GEMINI_API_KEY$|GOOGLE_API_KEY$|DASHSCOPE_API_KEY$|QWEN_API_KEY$|DEEPGRAM_API_KEY$|GROQ_API_KEY$|FCM_SERVICE_ACCOUNT_PATH$)/.test(key)) delete env[key];
if (command === 'up') {
  await fs.access(executable); // Install the official pinned package before running this launcher.
  let existing;
  try { existing = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) }); } catch { /* Not started. */ }
  if (!existing) {
    const log = openSync(path.join(lab, 'hub.log'), 'a', 0o600);
    const child = spawn(executable, ['hub', relayFlag], { cwd: directory, env, detached: true, stdio: ['ignore', log, log] });
    child.unref(); closeSync(log);
    await fs.writeFile(path.join(lab, 'hub-pid.json'), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
    for (let attempt = 0; attempt < 40; attempt++) {
      try { const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch { /* Startup. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const response = await fetch(`${url}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: settings.cliApiToken }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Port 3316 is not serving this lab hub. No Runner was started.');
  const auth = await response.json();
  // Keep the original upstream Runner and its machine identity inside the isolated HAPI_HOME.
  execFileSync(executable, ['runner', 'start', '--workspace-root', runnerRoot], { cwd: directory, env, stdio: 'ignore', timeout: 30000 });
  const binary = await fs.readFile(executable);
  await fs.writeFile(path.join(lab, 'runtime-manifest.json'), JSON.stringify({ upstream: '@twsxtd/hapi-darwin-arm64', version: '0.30.7', binarySha256: createHash('sha256').update(binary).digest('hex'), url, directory, runnerRoot, lanUrl: lanHost ? `http://${lanHost}:${hubPort}` : undefined, relay, androidPush: false, iosPush: false }, null, 2));
  const machines = await (await fetch(`${url}/api/machines`, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(5000) })).json();
  console.log(JSON.stringify({ ready: true, url, directory, machines: machines.machines?.map(machine => ({ id: machine.id, active: machine.active })), pairingTokenFile: settingsPath }, null, 2));
} else if (command === 'down') {
  execFileSync(executable, ['runner', 'stop'], { cwd: directory, env, stdio: 'ignore', timeout: 15000 });
  const { pid } = JSON.parse(await fs.readFile(path.join(lab, 'hub-pid.json'), 'utf8'));
  let processCommand = '';
  try { processCommand = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); } catch { /* Already stopped. */ }
  if ([`${executable} hub --no-relay`, `${executable} hub --relay`].includes(processCommand.trim())) {
    process.kill(pid, 'SIGTERM');
    for(let i=0;i<40;i++){try{process.kill(pid,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,100));}
  }
  else if (processCommand.trim()) throw Error('The recorded PID belongs to another process. It was not stopped.');
  console.log('Isolated HAPI lab stopped.');
} else if (command === 'status') {
  try { const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).json(); console.log(JSON.stringify({ url, health, directory, pairingTokenFile: settingsPath }, null, 2)); }
  catch { console.log('Isolated HAPI lab is offline.'); }
} else throw Error('Usage: node scripts/hapi-lab.mjs up|status|down');
