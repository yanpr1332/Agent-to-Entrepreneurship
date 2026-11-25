// Real packaged Worker smoke: run AFTER electron-vite build on Windows/macOS.
// No network, model downloads, external account, or production userData.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {Worker} from "node:worker_threads";

const file=resolve("out/main/knowledge-word-vector-worker.js");
assert.ok(existsSync(file),"Bundled word-vector Worker is missing from out/main");
const dir=mkdtempSync(join(tmpdir(),"study-anchor-worker-smoke-"));
const text="3 3\nenergy 1 0 0\nmitochondria 0.9 0.1 0\n线粒体 0.9 0.1 0\n";
const revision=createHash("sha256").update(text).digest("hex");
const input=join(dir,"test.vec");
writeFileSync(input,text);
const worker=new Worker(file);
let sequence=0;
const pending=new Map();
worker.on("message",message=>{
  const task=pending.get(message.id);
  if(task){pending.delete(message.id);task(message);}
});
async function request(data){
  const id=++sequence;
  return await Promise.race([
    new Promise(resolve=>{pending.set(id,resolve);worker.postMessage({id,...data});}),
    new Promise((_,reject)=>setTimeout(()=>reject(Error("Worker smoke timed out")),8000)),
  ]);
}
try{
  const init=await request({type:"init",path:input,revision});
  assert.equal(init.ok,true,"Local model must initialize in packaged Worker");
  assert.equal(init.model.revision,revision);
  assert.equal(init.model.dimension,3);
  const sample=await request({type:"embed",kind:"passage",
    texts:["mitochondria energy","线粒体产生 energy"]});
  assert.equal(sample.ok,true);
  assert.equal(sample.values.length,2);
  assert.ok(sample.values[0][0]>0.8);
  assert.ok(sample.values[1][0]>0.8);
  const invalid=await request({type:"embed",kind:"query",texts:["unknownunknown"]});
  assert.equal(invalid.ok,false,"Unknown words must not receive fabricated vectors");
  process.stdout.write("Bundled offline Worker smoke passed\n");
}finally{
  await worker.terminate();
  rmSync(dir,{force:true,recursive:true});
}
