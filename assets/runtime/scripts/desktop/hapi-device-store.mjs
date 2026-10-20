import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fault = (code,status=400) => Object.assign(new Error(code),{status});
export function commonProjectRoot(projects){
  if(!projects.length||projects.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw fault('INVALID_GRANT');
  let root=projects[0];
  while(projects.some(p=>p!==root&&!p.startsWith(root+path.sep))){const parent=path.dirname(root);if(parent===root)throw fault('PROJECT_ROOT_TOO_BROAD');root=parent;}
  if(root===path.parse(root).root)throw fault('PROJECT_ROOT_TOO_BROAD');return root;
}
export async function atomicJson(file,data) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await fs.writeFile(file+'.new',JSON.stringify(data),{mode:0o600});await fs.chmod(file+'.new',0o600);await fs.rename(file+'.new',file);
}
export class DeviceStore {
  constructor(file,{now=Date.now}={}) {this.file=file;this.now=now;this.serial=Promise.resolve();this.listeners=new Set();}
  async load(){try{this.data=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.data={version:1,hubId:randomUUID(),devices:{},pairings:{},outbox:{}};await this.save();}
    if(this.data.version!==1||!this.data.hubId||!this.data.devices||!this.data.pairings||!this.data.outbox)throw fault('STORAGE_ERROR',500);
  }
  save(){return atomicJson(this.file,this.data);}
  transaction(action){const r=this.serial.then(action);this.serial=r.catch(()=>{});return r;}
  async grants(input){
    if(!input||!Array.isArray(input.projects)||!input.projects.length||input.projects.length>20||!Array.isArray(input.capabilities)||input.capabilities.some(c=>!['read','dispatch'].includes(c))||!input.capabilities.includes('read'))throw fault('INVALID_GRANT');
    const projects=await Promise.all(input.projects.map(async p=>{if(typeof p!=='string'||!path.isAbsolute(p))throw fault('INVALID_GRANT');const real=await fs.realpath(p);if(!(await fs.stat(real)).isDirectory())throw fault('INVALID_GRANT');return real;}));
    const threadIds=input.threadIds??[];
    if(!Array.isArray(threadIds)||threadIds.length>500||threadIds.some(id=>!isId(id)))throw fault('INVALID_GRANT');
    return {projects:[...new Set(projects)],threadIds:[...new Set(threadIds)],capabilities:[...new Set(input.capabilities)]};
  }
  issuePairing(input){return this.transaction(async()=>{
    const grants=await this.grants(input.grants);const code=randomBytes(32).toString('base64url');
    const expiresAt=this.now()+120000;
    // Codes are single-use, 256-bit and short-lived. Disk contains only their hashes.
    for(const [key,p]of Object.entries(this.data.pairings))if(p.expiresAt<=this.now()||p.used)delete this.data.pairings[key];
    this.data.pairings[digest(code)]={grants,name:String(input.name||'手机').slice(0,80),expiresAt,used:false};
    await this.save();return {code,expiresAt,hubId:this.data.hubId};
  });}
  pair(code){return this.transaction(async()=>{
    const p=typeof code==='string'&&this.data.pairings[digest(code)];
    if(!p||p.expiresAt<=this.now())throw fault('PAIRING_EXPIRED',410);
    if(p.used)throw fault('PAIRING_ALREADY_USED',409);
    const id=randomUUID(),token='mcd_'+randomBytes(32).toString('base64url');
    const device={id,name:p.name,grants:p.grants,tokenHash:digest(token),createdAt:this.now(),revokedAt:null};
    p.used=true;this.data.devices[id]=device;await this.save();return {token,device:this.publicDevice(device),hubId:this.data.hubId};
  });}
  publicDevice(d){return {id:d.id,name:d.name,grants:structuredClone(d.grants),createdAt:d.createdAt,revokedAt:d.revokedAt};}
  authenticate(token){if(typeof token!=='string'||!/^mcd_[a-zA-Z0-9_-]{43}$/.test(token))throw fault('PAIRING_REQUIRED',401);const h=digest(token);const d=Object.values(this.data.devices).find(d=>d.tokenHash===h&&!d.revokedAt);if(!d)throw fault('PAIRING_REQUIRED',401);return d;}
  require(id,capability='read'){const d=this.data.devices[id];if(!d||d.revokedAt)throw fault('PAIRING_REQUIRED',401);if(!d.grants.capabilities.includes(capability))throw fault('ACCESS_DENIED',403);return d;}
  revoke(id){return this.transaction(async()=>{const d=this.require(id);d.revokedAt=this.now();await this.save();for(const fn of this.listeners)fn(id);return this.publicDevice(d);});}
  list(){return Object.values(this.data.devices).map(d=>this.publicDevice(d));}
}
export function isId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
