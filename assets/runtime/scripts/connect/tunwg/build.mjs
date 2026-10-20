// Reproducible, scoped upstream fix. No network routes, TLS trust, or proxy settings are changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,revision='122a6d0e43585bed8782ceb893394104b6640589';
const sourceUrl=`https://codeload.github.com/tiann/tunwg/tar.gz/${revision}`;
const sourceSha256='683bab2b270afa6c88d087d3250a78635fc650d71bfdedf9372739ba946d91af';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'moecast-tunwg-build-'));
const go=process.env.MOECAST_GO||'go';
const run=(exe,args,options={})=>execFileSync(exe,args,{cwd:tmp,stdio:'pipe',timeout:300000,...options});
try{
 run('curl',['--fail','--silent','--show-error','--max-time','60',sourceUrl,'-o','source.tgz']);
 if(createHash('sha256').update(await fs.readFile(path.join(tmp,'source.tgz'))).digest('hex')!==sourceSha256)throw Error('SOURCE_INTEGRITY_MISMATCH');
 run('tar',['-xzf','source.tgz','--strip-components=1']);
 run('patch',['-p1','-i',path.join(here,'certificate-fallback.patch')]);
 await fs.copyFile(path.join(here,'certificate_backoff_test.go'),path.join(tmp,'internal/certificate_backoff_test.go'));
 run(go,['test','./internal','./tunwg']);
 const output=path.join(here,'tunwg'),staging=path.join(here,'tunwg.next');
 run(go,['build','-trimpath',"-ldflags=-s -w",'-o',staging,'./tunwg'],{env:{...process.env,CGO_ENABLED:'0',GOOS:'darwin',GOARCH:'arm64'}});
 await fs.rename(staging,output);
 const licenses=path.join(here,'third-party-licenses');await fs.mkdir(licenses,{recursive:true});
 const modules=new Map(run(go,['list','-deps','-f','{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}','./tunwg']).toString().split('\n').filter(Boolean).map(row=>{const [module,version,dir]=row.split('|');return[module,{module,version,dir}];}));
 const index=[];
 for(const info of modules.values()){
  if(!info.dir||info.module==='github.com/ntnj/tunwg')continue;
  const names=(await fs.readdir(info.dir)).filter(n=>/^(LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(n));
  const files=[];for(const name of names){const source=path.join(info.dir,name);if(!(await fs.stat(source)).isFile())continue;const file=info.module.replaceAll('/','_')+'-'+name;await fs.copyFile(source,path.join(licenses,file));files.push(file);}
  if(!files.length)throw Error('DEPENDENCY_LICENSE_MISSING: '+info.module);index.push({module:info.module,version:info.version,files});
 }
 const goroot=run(go,['env','GOROOT']).toString().trim();await fs.copyFile(path.join(goroot,'LICENSE'),path.join(licenses,'Go-LICENSE'));index.push({module:'Go standard library',version:run(go,['version']).toString().trim(),files:['Go-LICENSE']});
 await fs.writeFile(path.join(licenses,'index.json'),JSON.stringify(index,null,2)+'\n');
 const hash=async f=>createHash('sha256').update(await fs.readFile(f)).digest('hex');
 await fs.writeFile(path.join(here,'build-manifest.json'),JSON.stringify({upstream:'https://github.com/tiann/tunwg',revision,sourceUrl,sourceSha256,patchSha256:await hash(path.join(here,'certificate-fallback.patch')),binarySha256:await hash(output),goVersion:run(go,['version']).toString().trim(),platform:'darwin-arm64',change:'Bound ACME retries so explicit rate limits reach the existing alternate issuer; omit EAB credential identifier from logs.'},null,2)+'\n');
 console.log('Pinned tunwg source verified, patched, tested and built.');
}finally{await fs.rm(tmp,{recursive:true,force:true});}
