import {execFile} from "node:child_process";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute,join} from "node:path";
import {promisify} from "node:util";

const exec=promisify(execFile);
export type NeuralRuntimeSource="managed"|"custom"|"system";
export type NeuralRuntimeReason=
  "ready"|"missing-python"|"invalid-config"|"unsupported-python"|
  "missing-packages"|"cpu-provider-unavailable"|"runtime-unavailable"|
  "timeout"|"invalid-response";
export interface NeuralRuntimeStatus{
  ready:boolean;
  source:NeuralRuntimeSource;
  reason:NeuralRuntimeReason;
  pythonVersion:string|null;
  missing:("numpy"|"onnxruntime"|"transformers")[];
}
export const NEURAL_RUNTIME_FOLDER=".study-anchor";
const MISSING=["numpy","onnxruntime","transformers"] as const;

/** Identical runtime resolution for startup/model installation and read-only
 * diagnostics. UserData/Renderer/IPC never supply a Python path.
 * A user-installed dedicated venv wins over ambient PATH Python.
 */
export function resolveNeuralPython(
  env:NodeJS.ProcessEnv=process.env,home=homedir(),
  platform=process.platform,exists:(file:string)=>boolean=existsSync,
):{command:string;source:NeuralRuntimeSource;invalid:false}|{
  command:null;source:"custom";invalid:true;
}{
  const override=env.STUDY_ANCHOR_PYTHON_PATH?.trim();
  if(override){
    if(!isAbsolute(override)||!exists(override))
      return {command:null,source:"custom",invalid:true};
    return {command:override,source:"custom",invalid:false};
  }
  const managed=join(home,NEURAL_RUNTIME_FOLDER,"neural-runtime",
    platform==="win32"?"Scripts/python.exe":"bin/python");
  if(exists(managed))return {command:managed,source:"managed",invalid:false};
  return {command:platform==="win32"?"python":"python3",source:"system",invalid:false};
}
function safeStatus(source:NeuralRuntimeSource,reason:NeuralRuntimeReason,
  pythonVersion:string|null=null,missing:NeuralRuntimeStatus["missing"]=[])
  :NeuralRuntimeStatus{
  return {ready:reason==="ready",source,reason,pythonVersion,missing};
}
/** Strict JSON protocol; no raw child stdout/stderr/filesystem paths escape. */
export function parseNeuralDoctorReply(
  raw:string,source:NeuralRuntimeSource,
):NeuralRuntimeStatus{
  if(raw.length>2000)throw Error("Malformed neural runtime diagnostic");
  let value:unknown;
  try{value=JSON.parse(raw.trim());}catch{throw Error("Malformed neural runtime diagnostic");}
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw Error("Malformed neural runtime diagnostic");
  const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!=="missing,pythonVersion,schema,status"||
    r.schema!==1||
    typeof r.pythonVersion!=="string"||!/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(r.pythonVersion)||
    !["ready","unsupported-python","missing-packages","cpu-provider-unavailable",
      "runtime-unavailable"].includes(String(r.status))||
    !Array.isArray(r.missing)||r.missing.length>3||
    r.missing.some(v=>typeof v!=="string"||!MISSING.includes(v as typeof MISSING[number]))||
    new Set(r.missing).size!==r.missing.length)
    throw Error("Malformed neural runtime diagnostic");
  if((r.status==="missing-packages")!==(r.missing.length>0))
    throw Error("Malformed neural runtime diagnostic");
  return safeStatus(source,r.status as NeuralRuntimeReason,r.pythonVersion,
    r.missing as NeuralRuntimeStatus["missing"]);
}
/** Does not install packages, touch the Knowledge DB, or invoke a model. */
export async function inspectNeuralRuntime(
  scriptPath:string,env:NodeJS.ProcessEnv=process.env,
):Promise<NeuralRuntimeStatus>{
  const target=resolveNeuralPython(env);
  if(target.invalid)return safeStatus("custom","invalid-config");
  try{
    const result=await exec(target.command,["-I",scriptPath],{
      timeout:30_000,maxBuffer:4096,windowsHide:true,
      env:{
        ...env,
        HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",
        HF_HUB_DISABLE_TELEMETRY:"1",TOKENIZERS_PARALLELISM:"false",
        PYTHONNOUSERSITE:"1",
      },
    });
    try{return parseNeuralDoctorReply(result.stdout,target.source);}
    catch{return safeStatus(target.source,"invalid-response");}
  }catch(error){
    const e=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    return safeStatus(target.source,
      e.killed||e.signal==="SIGTERM"?"timeout":"missing-python");
  }
}
