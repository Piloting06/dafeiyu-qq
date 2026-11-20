import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {activePort,bridgeServer} from '../slot-bridge.mjs';
const authorization = `Bearer ${'a'.repeat(32)}`;
test('only a single approved loopback active slot can be read', () => {
 assert.equal(activePort('# current\nserver 127.0.0.1:3200;\n'),3200);
 assert.equal(activePort('server 127.0.0.1:3201;'),3201);
 for(const text of ['server attacker:3200;','server 127.0.0.1:1234;','server 127.0.0.1:3200; server 127.0.0.1:3201;',''])assert.throws(()=>activePort(text));
});
test('slot changes are observed per request, credentials are not returned, failed awards are never retried',async()=>{
 let port=3200;const calls=[];
 const server=bridgeServer(async()=>port,async(url,options)=>{calls.push({url,options});return new Response('{"success":true}',{status:200});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const send=(path,body='{}',headers={authorization})=>fetch(base+path,{method:'POST',body,headers});
  assert.equal((await send('/api/user/self')).status,404);
  assert.equal((await send('/api/qq-community/official/message?redirect=x')).status,404);
  assert.equal((await send('/api/qq-community/official/message','{}',{})).status,401);
  assert.equal((await send('/api/qq-community/official/message','x'.repeat(65537))).status,413);
  assert.equal(calls.length,0);
  assert.equal((await send('/api/qq-community/official/policy')).status,200);
  port=3201;
  const response=await send('/api/qq-community/official/message');
  assert.equal(response.status,200);assert.equal(await response.text(),'{"success":true}');
  assert.equal(calls.length,2);assert.match(calls[0].url,/:3200/);assert.match(calls[1].url,/:3201/);
  assert.equal(calls[1].options.headers.Authorization,authorization);
  assert.equal(calls[1].options.redirect,'error');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('upstream failure returns a generic error with no retry',async()=>{
 let attempts=0;
 const server=bridgeServer(async()=>3200,async()=>{attempts++;throw new Error('private upstream diagnostic');});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/qq-community/official/message`,{method:'POST',headers:{authorization},body:'{}'});
  assert.equal(r.status,503);assert.equal(await r.text(),'{}');assert.equal(attempts,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('release symlink entry starts a persistent loopback service',async()=>{
 const {mkdtemp,symlink,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {fileURLToPath}=await import('node:url');
 const {spawn}=await import('node:child_process');
 const dir=await mkdtemp(join(tmpdir(),'qq-slot-'));
 const entry=join(dir,'current.mjs');
 await symlink(fileURLToPath(new URL('../slot-bridge.mjs',import.meta.url)),entry);
 await writeFile(join(dir,'upstream.conf'),'server 127.0.0.1:3200;');
 const child=spawn(process.execPath,[entry],{env:{...process.env,DAFEIYU_UPSTREAM_FILE:join(dir,'upstream.conf')},stdio:'pipe'});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 try{
  let ready=false;
  for(let i=0;i<40;i++){
   assert.equal(child.exitCode,null,stderr);
   try {const response=await fetch('http://127.0.0.1:52902/');ready=response.status===404;}catch{}
   if(ready)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(ready,true,stderr);
 }finally{
  if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
