#!/usr/bin/env node
/**
 * Explicit write-enabled personal file RLS acceptance on a USER-AUTHORIZED
 * DISPOSABLE Supabase project. No CI network calls or real personal files.
 * The operator supplies A/B test email+password and a PUBLIC project key.
 */
import {createHash,randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const FILE_TEST_CONFIRM="CREATE_DISPOSABLE_PERSONAL_FILE_TEST";
const TIMEOUT_MS=20_000;
function fail(label){throw Error("File RLS acceptance failed: "+label);}
export function validateFileAcceptanceEnvironment(env){
  if(env.ATE_FILE_CONFIRM_WRITES!==FILE_TEST_CONFIRM)
    fail("explicit isolated-project write confirmation missing");
  let url;
  try{url=new URL(env.ATE_FILE_URL);}catch{fail("invalid test project URL");}
  if(url.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)||
     url.pathname!=="/"||url.port||url.search||url.hash||url.username||url.password)
    fail("only HTTPS Supabase project roots are allowed");
  const key=env.ATE_FILE_ANON_KEY;
  if(typeof key!=="string"||key.length>4096||key.startsWith("sb_secret_"))
    fail("publishable or legacy anon key required, never secret/service_role");
  if(!/^sb_publishable_[a-zA-Z0-9_-]{12,}$/.test(key)){
    const parts=key.split(".");
    try{
      if(parts.length!==3||JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8")).role!=="anon")
        fail("service keys are prohibited");
    }catch{fail("only the public anon JWT is allowed");}
  }
  const people={};
  const emailSet=new Set();
  for(const who of ["A","B"]){
    const email=env["ATE_FILE_"+who+"_EMAIL"];
    const password=env["ATE_FILE_"+who+"_PASSWORD"];
    if(typeof email!=="string"||!/^([^\s@<>]+)@([^\s@<>]+\.[a-z]{2,63})$/i.test(email)||
       email.length>254||typeof password!=="string"||
       password.length<8||password.length>256)fail("invalid test credential "+who);
    if(emailSet.has(email.toLowerCase()))fail("A and B must have different logins");
    emailSet.add(email.toLowerCase());
    people[who]={email,password};
  }
  return {origin:url.origin,key,people};
}
export async function runFileAcceptance(env,fetcher=fetch){
  const {origin,key,people}=validateFileAcceptanceEnvironment(env);
  async function request(path,token,body){
    let response;
    try{response=await fetcher(origin+"/rest/v1/rpc/"+path,{
      method:"POST",
      headers:{apikey:key,Authorization:"Bearer "+token,
        Accept:"application/json","Content-Type":"application/json"},
      body:JSON.stringify(body),
      redirect:"error",signal:AbortSignal.timeout(TIMEOUT_MS),
    });}catch{fail("network interrupted (no automatic write retry)");}
    const data=await response.text().catch(()=>fail("unreadable remote response"));
    if(data.length>2_000_000)fail("remote response over limit");
    if(!response.ok)return {ok:false,status:response.status,value:null};
    let value;
    try{value=JSON.parse(data);}catch{fail("malformed successful RPC response");}
    return {ok:true,status:response.status,value};
  }
  async function login(who){
    const result=await fetcher(origin+"/auth/v1/token?grant_type=password",{
      method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,
        Accept:"application/json","Content-Type":"application/json"},
      body:JSON.stringify(people[who]),redirect:"error",
      signal:AbortSignal.timeout(TIMEOUT_MS),
    }).catch(()=>fail("auth network unavailable"));
    if(!result.ok)fail("test login "+who+" HTTP "+result.status);
    const body=await result.json().catch(()=>fail("invalid test login response"));
    if(typeof body.access_token!=="string"||
       typeof body.user?.id!=="string"||!/^([0-9a-f]{8}-){1}[0-9a-f-]{27,}$/i.test(body.user.id))
      fail("invalid login identity");
    return {token:body.access_token,id:body.user.id};
  }
  const a=await login("A"),b=await login("B");
  if(a.id===b.id)fail("test logins resolved to the same user ID");
  const id=randomUUID();
  const contentsA=Buffer.from("Synthetic A private file "+id);
  const contentsB=Buffer.from("Synthetic B private file "+id);
  function hash(bytes){return createHash("sha256").update(bytes).digest("hex");}
  function params(bytes,baseVersion,isDelete=false){
    return {p_file_id:id,p_base_version:baseVersion,
      p_filename:isDelete?null:"synthetic.md",p_sha256:isDelete?null:hash(bytes),
      p_byte_length:isDelete?null:bytes.byteLength,
      p_base64:isDelete?null:bytes.toString("base64"),p_delete:isDelete};
  }
  async function accepted(r,label){
    if(!r.ok||r.value?.status!=="accepted")fail(label);
    return r.value.version;
  }
  async function get(token){
    return request("ate_file_get",token,{p_file_id:id});
  }
  const versionA=await accepted(await request("ate_file_apply",a.token,
    params(contentsA,0)),"A synthetic file write");
  const aList=await request("ate_file_list",a.token,{});
  if(!aList.ok||!Array.isArray(aList.value)||!aList.value.some(x=>x.fileId===id))
    fail("A cannot read own file metadata");
  const bList=await request("ate_file_list",b.token,{});
  if(!bList.ok||!Array.isArray(bList.value)||bList.value.some(x=>x.fileId===id))
    fail("B leaked A file metadata");
  if((await get(b.token)).ok)fail("B read A private file content");

  // Same UUID in B's owner namespace is legal, but MUST NOT alter A's bytes.
  const versionB=await accepted(await request("ate_file_apply",b.token,
    params(contentsB,0)),"B isolated file write");
  const rawA=await get(a.token);
  const rawB=await get(b.token);
  if(!rawA.ok||!rawB.ok||
    Buffer.from(rawA.value.base64,"base64").compare(contentsA)!==0||
    Buffer.from(rawB.value.base64,"base64").compare(contentsB)!==0)
    fail("A/B owner scopes have mixed file data");

  const conflict=await request("ate_file_apply",a.token,
    params(Buffer.from("stale update"),0));
  if(!conflict.ok||conflict.value?.status!=="conflict")
    fail("stale A base version did not produce a conflict");
  const deleteA=await request("ate_file_apply",a.token,params(contentsA,versionA,true));
  await accepted(deleteA,"A owner deletion");
  if((await get(a.token)).ok)fail("deleted A content remained readable");
  if(!(await get(b.token)).ok)fail("A deletion unexpectedly removed B data");
  await accepted(await request("ate_file_apply",b.token,params(contentsB,versionB,true)),
    "B owner deletion");
  console.log("PASS: independent A/B JWT owner scopes, version CAS, byte integrity and tombstone.");
  console.log("Only synthetic files were used. Independently verify no unexpected rows remain.");
  return {passed:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await runFileAcceptance(process.env);}
  catch(error){
    console.error(error instanceof Error?error.message:"File RLS acceptance failed");
    process.exitCode=1;
  }
}
