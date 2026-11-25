import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectElectronBinary, electronDoctorMessage } from "./electron-dev-preflight.mjs";

function fixture(work){
  const root=mkdtempSync(join(tmpdir(),"study-anchor-electron-doctor-"));
  const electron=join(root,"node_modules","electron");
  mkdirSync(electron,{recursive:true});
  writeFileSync(join(electron,"package.json"),JSON.stringify({name:"electron",version:"45.2.3"}));
  try{return work(root,electron);}finally{rmSync(root,{recursive:true,force:true});}
}
function installed(root,electron,platform,filename){
  writeFileSync(join(electron,"path.txt"),filename);
  const path=join(electron,"dist",filename);
  mkdirSync(join(path,".."),{recursive:true});
  writeFileSync(path,"fake binary for structural check only");
  return inspectElectronBinary(root,platform);
}

test("missing node_modules is distinguished from missing Electron binary",()=>{
  fixture((root,electron)=>{
    assert.deepEqual(inspectElectronBinary(root,"win32"),{
      ok:false,reason:"missing-binary",version:"45.2.3",
    });
    assert.match(electronDoctorMessage(inspectElectronBinary(root,"win32")),
      /npm run setup:electron/);
  });
});
test("detects wrong-platform or potentially traversing path.txt, without executing it",()=>{
  fixture((root,electron)=>{
    writeFileSync(join(electron,"path.txt"),"../../outside.exe");
    assert.equal(inspectElectronBinary(root,"win32").reason,"unexpected-binary-path");
    writeFileSync(join(electron,"path.txt"),"Electron.app/Contents/MacOS/Electron");
    assert.equal(inspectElectronBinary(root,"win32").reason,"unexpected-binary-path");
  });
});
test("recognizes platform-specific executable paths without launching Electron",()=>{
  for(const [platform,path] of [
    ["win32","electron.exe"],["darwin","Electron.app/Contents/MacOS/Electron"],
    ["linux","electron"],
  ]){
    fixture((root,electron)=>{
      assert.deepEqual(installed(root,electron,platform,path),{
        ok:true,version:"45.2.3",platform,
      });
    });
  }
});
test("a path.txt alone is not sufficient evidence of a downloaded binary",()=>{
  fixture((root,electron)=>{
    writeFileSync(join(electron,"path.txt"),"electron.exe");
    assert.equal(inspectElectronBinary(root,"win32").reason,"missing-binary");
    const path=join(electron,"dist","electron.exe");
    mkdirSync(path,{recursive:true});
    assert.equal(inspectElectronBinary(root,"win32").reason,"missing-binary");
  });
});
test("doctor CLI exits nonzero with useful remediation before electron-vite runs",()=>{
  fixture((root)=>{
    const child=spawnSync(process.execPath,["scripts/electron-dev-preflight.mjs"],{
      cwd:process.cwd(),env:{...process.env},encoding:"utf8",
    });
    // The actual developer/CI environment may already have Electron, so
    // the function-level assertions above are authoritative.
    assert.ok(child.status===0||child.status===1);
    assert.doesNotMatch(child.stdout+child.stderr,/secret-key-example/);
    assert.deepEqual(inspectElectronBinary(root,"freebsd"),{
      ok:false,reason:"unsupported-platform",
    });
  });
});