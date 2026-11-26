#!/usr/bin/env node
/** Offline read-only diagnostic; never pip installs, imports a model or uses HTTP. */
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

export function pythonSelection(env=process.env,home=homedir(),platform=process.platform){
  const preferred=env.STUDY_ANCHOR_PYTHON_PATH?.trim();
  if(preferred){
    if(!isAbsolute(preferred)||!existsSync(preferred))
      return {command:null,source:"custom",reason:"invalid-config"};
    return {command:preferred,source:"custom"};
  }
  const managed=join(home,".study-anchor","neural-runtime",
    platform==="win32"?"Scripts/python.exe":"bin/python");
  if(existsSync(managed))return {command:managed,source:"managed"};
  return {command:platform==="win32"?"python":"python3",source:"system"};
}
export function runDoctor(env=process.env){
  const selection=pythonSelection(env);
  if(!selection.command){
    process.stderr.write("Configured STUDY_ANCHOR_PYTHON_PATH must be an existing absolute Python executable.\n");
    return 1;
  }
  const result=spawnSync(selection.command,["-I",resolve("scripts/neural-runtime-doctor.py")],{
    windowsHide:true,encoding:"utf8",timeout:30_000,maxBuffer:4096,
    env:{...env,HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",
      HF_HUB_DISABLE_TELEMETRY:"1",PYTHONNOUSERSITE:"1"},
  });
  if(result.error||result.status!==0){
    process.stderr.write("Neural runtime unavailable ("+selection.source+"). Use npm run setup:neural:runtime -- --online or supply offline wheels.\n");
    return 1;
  }
  let reply;
  try{reply=JSON.parse(result.stdout);}
  catch{
    process.stderr.write("Invalid neural runtime diagnostic; refusing to activate neural model.\n");
    return 1;
  }
  if(reply.schema!==1||!["ready","missing-packages","unsupported-python",
    "cpu-provider-unavailable","runtime-unavailable"].includes(reply.status)||
    !Array.isArray(reply.missing)||reply.missing.length>3){
    process.stderr.write("Invalid neural runtime diagnostic; refusing to activate neural model.\n");
    return 1;
  }
  process.stdout.write("Neural CPU runtime ["+selection.source+"]: "+reply.status+
    ", Python "+String(reply.pythonVersion||"unavailable")+
    (reply.missing.length?" (missing: "+reply.missing.join(", ")+")":"")+"\n");
  if(reply.status!=="ready"){
    process.stdout.write("Setup: npm run setup:neural:runtime -- --online (explicit downloads), or --wheelhouse ABSOLUTE_DIRECTORY (offline).\n");
    return 1;
  }
  process.stdout.write("Runtime dependencies ready; still requires a separately verified ONNX model and real-model acceptance.\n");
  return 0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.exitCode=runDoctor();
