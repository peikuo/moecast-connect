import {fault} from './hapi-device-store.mjs';
/** Read-only correlation. Never queue, resume, or start a native thread. */
export async function findNativeRequest(directory,device,threadId,nativeMessageId){
 let cursor;const seen=new Set(),until=Date.now()+10000;
 for(let page=0;page<20;page++){
  const history=await directory.readNative(device,threadId,cursor);
  const users=history.messages.filter(m=>m.role==='user'&&m.clientId===nativeMessageId);
  if(users.length>1)throw fault('NATIVE_MESSAGE_AMBIGUOUS',409);
  if(users.length===1)return{history,user:users[0],turn:history.turns?.find(t=>t.id===users[0].turnId)};
  if(!history.nextCursor||seen.has(history.nextCursor)||Date.now()>=until)return;seen.add(history.nextCursor);cursor=history.nextCursor;
 }
}
