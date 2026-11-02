import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isId} from './hapi-device-store.mjs';

/** Independent computer identity; losing it must never silently invalidate pairing. */
export async function computerIdentity(home, state) {
  const file=path.join(home,'identity.json');
  try {
    const identity=JSON.parse(await fs.readFile(file,'utf8'));
    if(identity.version!==1||!isId(identity.machineId))throw Error('COMPUTER_IDENTITY_INVALID');
    return identity.machineId;
  } catch(error) {
    if(error.code!=='ENOENT')throw error;
  }
  if(Object.keys(state.devices??{}).length||Object.keys(state.pairings??{}).length)throw Error('COMPUTER_IDENTITY_MISSING');
  const identity={version:1,machineId:randomUUID()};
  await fs.mkdir(home,{recursive:true,mode:0o700});
  try { await fs.writeFile(file,JSON.stringify(identity),{flag:'wx',mode:0o600}); }
  catch(error) { if(error.code!=='EEXIST')throw error; return computerIdentity(home,state); }
  return identity.machineId;
}
