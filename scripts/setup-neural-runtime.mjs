#!/usr/bin/env node
/**
 * EXPLICIT optional Python CPU runtime installer. Never called at app startup,
 * npm ci, npm test, or Electron packaging. The offline wheelhouse is preferred;
 * '--online' deliberately allows PyPI downloads, after user approval.
 */
import {spawnSync} from "node:child_process";
import {existsSync,mkdirSync,lstatSync} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute,join,resolve} from "node:path";

const base=join(homedir(),".study-anchor","neural-runtime");
const interpreter=join(base,process.platform==="win32"?"Scripts":"bin",
  process.platform==="win32"?"python.exe":"python");
const requirements=resolve("scripts","neural-requirements.txt");
export function parseSetupOptions(argv){
  const args=[...argv];
  if(args.length===1&&args[0]==="--online")
    return {mode:"online",wheelhouse:null};
  if(args.length===2&&args[0]==="--wheelhouse"&&
    isAbsolute(args[1])&&existsSync(args[1])&&
    lstatSync(args[1]).isDirectory()&&!lstatSync(args[1]).isSymbolicLink())
    return {mode:"offline",wheelhouse:args[1]};
  throw Error("Choose explicitly: --online (downloads Python wheels) OR --wheelhouse ABSOLUTE_DIRECTORY (offline)");
}
function run(program,args,option={}){
  const response=spawnSync(program,args,{stdio:"inherit",windowsHide:true,
    shell:false,env:{...process.env,PIP_DISABLE_PIP_VERSION_CHECK:"1"},...option});
  if(response.error||response.status!==0)
    throw Error("Neural setup command failed (stage: "+args.slice(0,3).join(" ")+")");
}
function main(){
  const {mode,wheelhouse}=parseSetupOptions(process.argv.slice(2));
  const python=process.env.STUDY_ANCHOR_SETUP_PYTHON?.trim()||
    (process.platform==="win32"?"python":"python3");
  if(isAbsolute(python)&&!existsSync(python))throw Error("Configured Python path does not exist");
  const check=spawnSync(python,["-I","-c",
    "import sys;sys.exit(0 if (3,11)<=sys.version_info[:2]<(3,14) else 2)"],
    {stdio:"ignore",shell:false,windowsHide:true});
  if(check.status!==0)throw Error("Python 3.11–3.13 is required to create a neural environment");
  if(existsSync(base)){
    const st=lstatSync(base);
    if(st.isSymbolicLink()||!st.isDirectory())throw Error("Unsafe managed Python runtime path");
  }else{
    mkdirSync(join(homedir(),".study-anchor"),{recursive:true,mode:0o700});
    run(python,["-m","venv",base]);
  }
  if(!existsSync(interpreter))throw Error("Managed neural Python executable is missing");
  const pipArgs=["-I","-m","pip","install","--isolated","--no-input",
    "--disable-pip-version-check","--only-binary=:all:"];
  if(mode==="offline")pipArgs.push("--no-index","--find-links",wheelhouse);
  else pipArgs.push("--index-url","https://pypi.org/simple");
  pipArgs.push("-r",requirements);
  process.stdout.write(mode==="online"?
    "[Study Anchor] You explicitly permitted third-party Python package downloads.\n":
    "[Study Anchor] Installing only from locally selected wheelhouse (no package downloads).\n");
  run(interpreter,pipArgs);
  // pip success is not sufficient: reject a broken native wheel, an absent
  // CPU provider or an unexpected diagnostic before calling setup completed.
  const doctor=spawnSync(interpreter,["-I",resolve("scripts","neural-runtime-doctor.py")],{
    windowsHide:true,encoding:"utf8",timeout:30_000,maxBuffer:4096,
    env:{...process.env,HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",
      HF_HUB_DISABLE_TELEMETRY:"1",PYTHONNOUSERSITE:"1"},
  });
  let diagnosis;
  try{diagnosis=JSON.parse(doctor.stdout||"");}catch{/* fail closed */}
  if(doctor.error||doctor.status!==0||diagnosis?.schema!==1||diagnosis.status!=="ready")
    throw Error("Python dependencies installed, but ONNX CPU runtime doctor did not pass");
  process.stdout.write("[Study Anchor] Verified optional CPU Python environment under the current user's home directory.\n");
  process.stdout.write("Next: npm run doctor:neural, then import a separately reviewed local E5/BGE ONNX model.\n");
}
const isMain=process.argv[1]&&resolve(process.argv[1])===resolve("scripts","setup-neural-runtime.mjs");
if(isMain){
  try{main();}
  catch(error){
    process.stderr.write("[Study Anchor] "+(error instanceof Error?error.message:"Setup failed")+"\n");
    process.exitCode=1;
  }
}
