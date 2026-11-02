// Explicit computer-side deliveries only. A device can never submit a filesystem path.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {findNativeRequest} from './native-request.mjs';
import {digest,fault,isId} from './hapi-device-store.mjs';

export const artifactLimits={maxBytes:50*1024*1024,maxImageBytes:20*1024*1024,chunkBytes:256*1024,maxPerDevice:100,maxDeviceBytes:200*1024*1024,defaultTtlMs:86400000,maxTtlMs:7*86400000};
const exec=promisify(execFile);
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const contained=(root,file)=>file.startsWith(root+path.sep);
function contentType(data){
  if(data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return'image/png';
  if(data[0]===255&&data[1]===216&&data[2]===255)return'image/jpeg';
  if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return'image/webp';
  if(/^GIF8[79]a$/.test(data.subarray(0,6).toString()))return'image/gif';
  if(data.subarray(0,5).toString()==='%PDF-')return'application/pdf';
  if(data.length>=12&&data.subarray(4,8).toString()==='ftyp'&&['isom','iso2','mp41','mp42','avc1','M4V ','MSNV','dash'].includes(data.subarray(8,12).toString()))return'video/mp4';
  if(data.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))&&data.subarray(0,4096).includes(Buffer.from('webm')))return'video/webm';
  // Unknown, executable and active document formats are downloads, never inline HTML/SVG.
  return'application/octet-stream';
}
async function privateDirectory(directory){
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const s=await fs.lstat(directory);if(!s.isDirectory()||s.isSymbolicLink())throw fault('ARTIFACT_STORAGE_INVALID',500);
  await fs.chmod(directory,0o700);
}
async function readSource(project,file){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0')||file.split(path.sep).includes('..'))throw fault('ARTIFACT_PATH_DENIED',403);
  const resolved=path.resolve(file);
  if(!contained(project,resolved)||await fs.realpath(project)!==project)throw fault('ARTIFACT_PATH_DENIED',403);
  // Reject every symlink component, including the project itself. Match the opened inode
  // to the pre-open inode so a directory replacement cannot substitute another file.
  let current=path.parse(resolved).root;
  for(const part of resolved.slice(current.length).split(path.sep)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw fault('ARTIFACT_PATH_DENIED',403);}
  const before=await fs.lstat(resolved);
  if(!before.isFile()||before.nlink!==1)throw fault('ARTIFACT_PATH_DENIED',403);
  if(before.size>artifactLimits.maxBytes)throw Object.assign(fault('ARTIFACT_TOO_LARGE',413),{artifactSize:before.size,artifactLimit:artifactLimits.maxBytes});
  const handle=await fs.open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    if(identity(await handle.stat())!==identity(before)||await fs.realpath(resolved)!==resolved)throw fault('ARTIFACT_CHANGED',409);
    const data=Buffer.alloc(before.size);let offset=0;
    while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)throw fault('ARTIFACT_CHANGED',409);offset+=bytesRead;}
    if(identity(await handle.stat())!==identity(before)||identity(await fs.lstat(resolved))!==identity(before))throw fault('ARTIFACT_CHANGED',409);
    return data;
  }finally{await handle.close();}
}
export function explicitArtifactLinks(text){
  return [...text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g)].map(m=>{
    let value=m[1].replace(/^<|>$/g,'');
    try{value=decodeURIComponent(value);}catch{return null;}
    // No web URL fetch, file:// URL, line-suffix guessing, or free-text path extraction.
    return path.isAbsolute(value)?value:null;
  }).filter(Boolean);
}
async function thumbnail(data,mime,directory,id){
  if(process.platform!=='darwin'||!['image/png','image/jpeg','image/webp'].includes(mime))return null;
  const input=path.join(directory,id+'.original'),output=path.join(directory,id+'.thumbnail');
  try{
    // Dimension check before invoking the image decoder; cap pathological raster inputs.
    const {stdout}=await exec('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',input],{timeout:5000,maxBuffer:8192});
    const width=Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]),height=Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if(!width||!height||width*height>40000000) return null;
    await exec('/usr/bin/sips',['-s','format','png','-Z','512',input,'--out',output],{timeout:10000,maxBuffer:8192});
    await fs.chmod(output,0o600);const image=await fs.readFile(output);
    if(image.length>1024*1024||contentType(image)!=='image/png')throw Error();
    return {mime:'image/png',size:image.length,sha256:digest(image),identity:identity(await fs.stat(output))};
  }catch{await fs.rm(output,{force:true});return null;}
}
export class ArtifactDelivery {
  constructor({store,directory,now=Date.now}){Object.assign(this,{store,directory,now});this.root=path.join(path.dirname(store.file),'deliveries');this.queue=Promise.resolve();}
  serial(action){const task=this.queue.then(action);this.queue=task.catch(()=>{});return task;}
  receipt(deviceId,requestId){
    const direct=this.store.data.outbox[deviceId+':'+requestId];
    const assistant=this.store.data.assistantRequests?.[deviceId+':'+requestId]?.result?.receipt;
    const receipt=direct??(assistant&&this.store.data.outbox[deviceId+':'+assistant.requestId]);
    if(!receipt||receipt.state!=='accepted')throw fault('DELIVERY_RECEIPT_REQUIRED',409);return receipt;
  }
  async scope(deviceId,receipt,history=false){
    const device=this.store.require(deviceId),result=await (!history&&this.directory.authorization?this.directory.authorization(device,receipt.threadId):this.directory.read(device,receipt.threadId));
    this.store.require(deviceId);
    if(device.grants.threadIds.length&&!device.grants.threadIds.includes(receipt.threadId))throw fault('ACCESS_DENIED',403);
    return result;
  }
  metadata(row){const {snapshot,project,deviceId,sourcePath,readRequestId,sourceThreadId,...publicRow}=row;return {...publicRow,thumbnail:row.thumbnail?{mime:row.thumbnail.mime,size:row.thumbnail.size,sha256:row.thumbnail.sha256}:null};}
  async cleanup(){
    const rows=this.store.data.artifactDeliveries??{};let changed=false;
    for(const row of Object.values(rows))if(row.expiresAt<=this.now()||this.store.data.devices[row.deviceId]?.revokedAt){
      for(const variant of ['original','thumbnail'])await fs.rm(path.join(this.root,row.id+'.'+variant),{force:true});
      delete rows[row.id];changed=true;
    }
    if(changed)await this.store.transaction(()=>this.store.save());
  }
  publish(input){return this.serial(async()=>{
    const {deviceId,requestId,sourceMessageId,file}=input;
    if(!isId(deviceId)||typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(requestId)||typeof sourceMessageId!=='string'||sourceMessageId.length>200)throw fault('INVALID_DELIVERY');
    const ttlMs=input.ttlMs??artifactLimits.defaultTtlMs;
    if(!Number.isSafeInteger(ttlMs)||ttlMs<60000||ttlMs>artifactLimits.maxTtlMs)throw fault('INVALID_DELIVERY');
    const native=this.store.data.assistantRequests?.[deviceId+':'+requestId];
    if(native?.transport==='desktop_native'){
      const query=this.readQuery(deviceId,requestId);if(!query.files.includes(file)||!query.native.finalMessageIds.includes(sourceMessageId))throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
      const found=await findNativeRequest(this.directory,this.store.require(deviceId),native.frontdeskThreadId,native.nativeMessageId);
      const source=found?.history.messages.find(m=>m.id===sourceMessageId&&m.turnId===query.native.turnId&&m.phase==='final_answer'&&explicitArtifactLinks(m.text).includes(file));
      if(found?.turn?.status!=='completed'||!source)throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
      // Only the private computer-side admin socket can explicitly approve this
      // exact, reply-evidenced file. Device list/chunk requests cannot grant paths.
      let project;
      if(input.authorizeFile===true){
        if(!path.isAbsolute(file)||file.split(path.sep).includes('..'))throw fault('ARTIFACT_PATH_DENIED',403);
        project=path.dirname(file);
        if(project===path.parse(project).root)throw fault('ARTIFACT_PATH_DENIED',403);
      }else project=await this.directory.attachmentRoot(this.store.require(deviceId),native.frontdeskThreadId,source.id,file,{native:true});
      return this.snapshot({deviceId,requestId,readRequestId:requestId,threadId:native.frontdeskThreadId,sourceMessageId,project,file,ttlMs});
    }
    const receipt=this.receipt(deviceId,requestId),history=await this.scope(deviceId,receipt,true);
    if(!Array.isArray(receipt.baselineMessageIds))throw fault('DELIVERY_BASELINE_REQUIRED',409);
    const messages=history.messages??[],index=messages.findIndex(m=>m.id===sourceMessageId&&m.role==='agent'&&m.phase==='final_answer');
    const source=messages[index],baseline=new Set(receipt.baselineMessageIds);
    const matching=messages.filter(m=>m.role==='user'&&!baseline.has(m.id)&&digest(JSON.stringify([receipt.threadId,m.text]))===receipt.digest);
    const nearest=messages.slice(0,index).findLast(m=>m.role==='user');
    if(!source||baseline.has(source.id)||matching.length!==1||nearest?.id!==matching[0].id||!explicitArtifactLinks(source.text).includes(file))throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
    return this.snapshot({deviceId,requestId:receipt.requestId,threadId:receipt.threadId,sourceMessageId,project:history.target.project,file,ttlMs});
  });}
  async snapshot({deviceId,requestId,threadId,sourceMessageId,project,file,ttlMs,readRequestId,sourceThreadId}){
    await privateDirectory(this.root);await this.cleanup();
    const rows=Object.values(this.store.data.artifactDeliveries??{}).filter(r=>r.deviceId===deviceId);
    const rememberTooLarge=async(size,limit)=>{
      const name=path.basename(file).replace(/[\x00-\x1f\x7f]/g,'_').slice(0,240);
      if(rows.some(r=>r.state==='too_large'&&r.requestId===requestId&&r.sourceMessageId===sourceMessageId&&r.name===name&&r.size===size))return;
      if(rows.length>=artifactLimits.maxPerDevice)throw fault('ARTIFACT_QUOTA',413);
      const id=randomUUID(),row={id,deviceId,requestId:requestId,threadId:threadId,sourceMessageId,project:project,name,size,limit,state:'too_large',...(readRequestId?{readRequestId,sourcePath:file}:{}),...(sourceThreadId?{sourceThreadId}:{}),thumbnail:null,createdAt:this.now(),expiresAt:this.now()+ttlMs};
      await this.store.transaction(async()=>{this.store.require(deviceId);this.store.data.artifactDeliveries??={};this.store.data.artifactDeliveries[id]=row;await this.store.save();});
    };
    let data;try{data=await readSource(project,file);}catch(error){if(error.message==='ARTIFACT_TOO_LARGE'&&Number.isSafeInteger(error.artifactSize))await rememberTooLarge(error.artifactSize,error.artifactLimit);throw error;}
    const mime=contentType(data);
    if(mime.startsWith('image/')&&data.length>artifactLimits.maxImageBytes){await rememberTooLarge(data.length,artifactLimits.maxImageBytes);throw fault('ARTIFACT_TOO_LARGE',413);}

    const hash=digest(data),duplicate=rows.find(r=>r.requestId===requestId&&r.sourceMessageId===sourceMessageId&&r.sha256===hash&&r.name===path.basename(file));
    if(duplicate)return this.metadata(duplicate);
    if(rows.length>=artifactLimits.maxPerDevice||rows.filter(r=>r.state!=='too_large').reduce((n,r)=>n+r.size+(r.thumbnail?.size??0),0)+data.length+1024*1024>artifactLimits.maxDeviceBytes)throw fault('ARTIFACT_QUOTA',413);
    const id=randomUUID(),destination=path.join(this.root,id+'.original');
    await fs.writeFile(destination,data,{flag:'wx',mode:0o600});
    try{
      const row={id,deviceId,requestId:requestId,threadId:threadId,sourceMessageId,project:project,name:path.basename(file).replace(/[\x00-\x1f\x7f]/g,'_').slice(0,240),mime,size:data.length,sha256:hash,createdAt:this.now(),expiresAt:this.now()+ttlMs,state:'available',...(readRequestId?{readRequestId,sourcePath:file}:{}),...(sourceThreadId?{sourceThreadId}:{}),snapshot:identity(await fs.stat(destination)),thumbnail:await thumbnail(data,mime,this.root,id)};
      await this.store.transaction(async()=>{this.store.require(deviceId);this.store.data.artifactDeliveries??={};this.store.data.artifactDeliveries[id]=row;await this.store.save();});return this.metadata(row);
    }catch(error){for(const variant of ['original','thumbnail'])await fs.rm(path.join(this.root,id+'.'+variant),{force:true});throw error;}
  }
  readQuery(deviceId,requestId){
    this.store.require(deviceId);const query=this.store.data.assistantRequests?.[deviceId+':'+requestId];
    if(query?.transport==='desktop_native'){
      const source=query.result?.source;
      if(query.state!=='completed'||query.result?.kind!=='reply'||source?.threadId!==query.frontdeskThreadId||source?.nativeMessageId!==query.nativeMessageId||!isId(source?.turnId)||!Array.isArray(source?.finalMessageIds)||!source.finalMessageIds.length)throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
      const files=[...new Set(explicitArtifactLinks(query.result.text??''))];if(files.length>10)throw fault('ARTIFACT_QUOTA',413);
      return {targets:[query.frontdeskThreadId],files,native:source};
    }
    if(query?.state!=='completed'||query.result?.kind!=='reply'||query.result?.readOnly!==true)throw fault('DELIVERY_RECEIPT_REQUIRED',409);
    const targets=[...new Set((query.toolCalls??[]).filter(call=>call.name==='read_thread'&&isId(call.targetId)).map(call=>call.targetId))];
    if(!targets.length||targets.length>10)throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
    const files=[...new Set(explicitArtifactLinks(query.result.text??''))];if(files.length>10)throw fault('ARTIFACT_QUOTA',413);
    return {targets,files};
  }
  async readReplyAttachments(deviceId,requestId,name,errors){
    const query=this.readQuery(deviceId,requestId),device=this.store.require(deviceId);
    for(const threadId of query.targets){
      const found=query.native?await findNativeRequest(this.directory,device,threadId,query.native.nativeMessageId):null;
      if(query.native&&(found?.turn?.status!=='completed'||found.turn.id!==query.native.turnId))throw fault('DELIVERY_EVIDENCE_REQUIRED',409);
      const history=query.native?found.history:await this.directory.read(device,threadId);this.store.require(deviceId);
      for(const file of query.files.filter(file=>!name||path.basename(file)===name)){
       try{
        const existing=Object.values(this.store.data.artifactDeliveries??{}).find(row=>row.deviceId===deviceId&&row.readRequestId===requestId&&row.sourcePath===file);
        if(existing){await this.rowScope(deviceId,existing);continue;}
        const source=(history.messages??[]).findLast(message=>message.role==='agent'&&message.phase==='final_answer'&&(!query.native||query.native.finalMessageIds.includes(message.id))&&explicitArtifactLinks(message.text??'').includes(file));
        if(!source)continue;
        let project=history.target.project,sourceThreadId;
        if(!contained(project,file)){
          if(!this.directory.attachmentRoot)continue;
          if(this.directory.attachmentSource)({project,sourceThreadId}=await this.directory.attachmentSource(device,threadId,source.id,file,{native:!!query.native}));
          else project=await this.directory.attachmentRoot(device,threadId,source.id,file,{native:!!query.native});
        }
        await this.snapshot({deviceId,requestId,readRequestId:requestId,threadId,sourceMessageId:source.id,project,sourceThreadId,file,ttlMs:artifactLimits.defaultTtlMs});
       }catch(error){
        if(error.message==='ARTIFACT_TOO_LARGE')continue;
        if(!errors)throw error;
        errors.push({name:path.basename(file),code:/^[A-Z_]+$/.test(error.message)?error.message:'ARTIFACT_UNAVAILABLE'});
       }
      }
    }
    return requestId;
  }
  prepareNative(deviceId,requestId){return this.serial(async()=>{
    const query=this.readQuery(deviceId,requestId);
    if(!query.native||!query.files.length)return;
    await this.cleanup();
    const errors=[];
    try{await this.readReplyAttachments(deviceId,requestId,undefined,errors);}
    catch(error){for(const file of query.files)errors.push({name:path.basename(file),code:/^[A-Z_]+$/.test(error.message)?error.message:'ARTIFACT_UNAVAILABLE'});}
    this.store.require(deviceId);
    const rows=Object.values(this.store.data.artifactDeliveries??{}).filter(r=>r.deviceId===deviceId&&r.readRequestId===requestId&&r.expiresAt>this.now()&&!errors.some(e=>e.name===r.name));
    // Never report success for a missing/unmatched final-message link.
    for(const file of query.files)if(!rows.some(r=>r.sourcePath===file)&&!errors.some(e=>e.name===path.basename(file)))errors.push({name:path.basename(file),code:'DELIVERY_EVIDENCE_REQUIRED'});
    return {version:1,state:errors.length?(rows.length?'partial':'failed'):'ready',artifacts:rows.filter(r=>r.state!=='too_large').map(r=>this.metadata(r)),blocked:rows.filter(r=>r.state==='too_large').map(r=>this.metadata(r)),errors};
  });}
  async rowScope(deviceId,row){
    if(!row.readRequestId)return this.scope(deviceId,this.receipt(deviceId,row.requestId));
    const query=this.readQuery(deviceId,row.readRequestId);
    if(!query.targets.includes(row.threadId)||!query.files.includes(row.sourcePath))throw fault('ACCESS_DENIED',403);
    const device=this.store.require(deviceId);
    const scope=await (this.directory.authorization?this.directory.authorization(device,row.threadId):this.directory.read(device,row.threadId));
    if(row.sourceThreadId){const source=await this.directory.authorization(device,row.sourceThreadId);if(source.target.project!==row.project)throw fault('ACCESS_DENIED',403);}
    this.store.require(deviceId);if(!contained(row.project,row.sourcePath))throw fault('ACCESS_DENIED',403);
    return {target:{...scope.target,project:row.project}};
  }
  list(deviceId,requestId,name){return this.serial(async()=>{
    this.store.require(deviceId);await this.cleanup();let resolved;
    try{const receipt=this.receipt(deviceId,requestId);await this.scope(deviceId,receipt);resolved=receipt.requestId;}
    catch(error){if(error.message!=='DELIVERY_RECEIPT_REQUIRED')throw error;resolved=await this.readReplyAttachments(deviceId,requestId,name);}
    const rows=Object.values(this.store.data.artifactDeliveries??{}).filter(r=>r.deviceId===deviceId&&r.requestId===resolved&&(!name||r.name===name));
    return {artifacts:rows.filter(r=>r.state!=='too_large').map(r=>this.metadata(r)),blocked:rows.filter(r=>r.state==='too_large').map(r=>this.metadata(r)),limits:artifactLimits};
  });}
  async chunk(deviceId,{artifactId,variant='original',offset=0,...extra}){
    if(Object.keys(extra).length||!isId(artifactId)||!['original','thumbnail'].includes(variant)||!Number.isSafeInteger(offset)||offset<0)throw fault('INVALID_ARTIFACT_REQUEST');
    this.store.require(deviceId);const row=this.store.data.artifactDeliveries?.[artifactId];
    if(!row||row.deviceId!==deviceId)throw fault('ARTIFACT_NOT_FOUND',404);
    if(row.state==='too_large')throw fault('ARTIFACT_TOO_LARGE',413);
    if(row.expiresAt<=this.now())throw fault('ARTIFACT_EXPIRED',410);
    const scope=await this.rowScope(deviceId,row);
    if(row.expiresAt<=this.now())throw fault('ARTIFACT_EXPIRED',410);
    if(scope.target.project!==row.project)throw fault('ACCESS_DENIED',403);
    const spec=variant==='original'?{size:row.size,sha256:row.sha256,identity:row.snapshot}:row.thumbnail;
    if(!spec)throw fault('ARTIFACT_VARIANT_UNAVAILABLE',404);
    if(offset>spec.size)throw fault('ARTIFACT_RANGE_INVALID',416);
    let handle;try{
      handle=await fs.open(path.join(this.root,artifactId+'.'+variant),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const before=await handle.stat();if(!before.isFile()||identity(before)!==spec.identity)throw fault('ARTIFACT_CHANGED',409);
      const buffer=Buffer.alloc(Math.min(artifactLimits.chunkBytes,spec.size-offset));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
      if(bytesRead!==buffer.length||identity(await handle.stat())!==spec.identity)throw fault('ARTIFACT_CHANGED',409);
      this.store.require(deviceId);
      return {artifactId,variant,offset,nextOffset:offset+bytesRead,totalBytes:spec.size,sha256:spec.sha256,chunkSha256:digest(buffer),data:buffer.toString('base64'),encoding:'base64',eof:offset+bytesRead===spec.size};
    }catch(error){if(error.code==='ENOENT')throw fault('ARTIFACT_UNAVAILABLE',410);throw error;}finally{await handle?.close();}
  }
}
