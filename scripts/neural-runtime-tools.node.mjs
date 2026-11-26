import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {parseSetupOptions} from "./setup-neural-runtime.mjs";
import {pythonSelection} from "./neural-runtime-doctor.mjs";

test("installer is explicitly opt-in, never guesses network vs offline",()=>{
  for(const args of [[],["--help"],["--offline"],["--online","more"],
    ["--wheelhouse","relative/path"],["--wheelhouse"]])
    assert.throws(()=>parseSetupOptions(args),/Choose explicitly/);
  assert.deepEqual(parseSetupOptions(["--online"]),{mode:"online",wheelhouse:null});
});
test("offline installation allows only an existing real absolute wheel directory",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sa-neural-wheelhouse-"));
  try{
    assert.deepEqual(parseSetupOptions(["--wheelhouse",dir]),{
      mode:"offline",wheelhouse:dir,
    });
    const fake=join(dir,"not-a-dir");writeFileSync(fake,"data");
    assert.throws(()=>parseSetupOptions(["--wheelhouse",fake]));
    if(process.platform!=="win32"){
      const link=join(dir,"linked");
      symlinkSync(dir,link);
      assert.throws(()=>parseSetupOptions(["--wheelhouse",link]));
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("runtime CLI and Electron use identical private-venv location preference",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sa-neural-home-"));
  try{
    const bin=join(dir,".study-anchor","neural-runtime",
      process.platform==="win32"?"Scripts":"bin");
    mkdirSync(bin,{recursive:true});
    const path=join(bin,process.platform==="win32"?"python.exe":"python");
    writeFileSync(path,"synthetic, never executed");
    assert.deepEqual(pythonSelection({},dir,process.platform),{command:path,source:"managed"});
    assert.deepEqual(pythonSelection({STUDY_ANCHOR_PYTHON_PATH:"relative/python"},
      dir,process.platform),{command:null,source:"custom",reason:"invalid-config"});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("executing installer with no explicit mode never creates a virtualenv or contacts a provider",()=>{
  const home=mkdtempSync(join(tmpdir(),"sa-neural-no-install-"));
  try{
    const script=resolve("scripts/setup-neural-runtime.mjs");
    const result=spawnSync(process.execPath,[script],{
      encoding:"utf8",env:{...process.env,HOME:home,USERPROFILE:home},
      timeout:3000,
    });
    assert.equal(result.status,1);
    assert.match(result.stderr,/Choose explicitly/);
  }finally{rmSync(home,{recursive:true,force:true});}
});
