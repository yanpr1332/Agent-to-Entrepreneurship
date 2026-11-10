#!/usr/bin/env node
/**
 * Manual, state-changing acceptance script for an ISOLATED Supabase test project.
 * Does not run in GitHub CI. Creates a throwaway workspace and test message.
 *
 * Required environment variables:
 *   ATE_POC_URL, ATE_POC_ANON_KEY,
 *   ATE_POC_A_EMAIL, ATE_POC_A_PASSWORD,
 *   ATE_POC_B_EMAIL, ATE_POC_B_PASSWORD,
 *   ATE_POC_C_EMAIL, ATE_POC_C_PASSWORD
 *
 * Never paste these values into chats or GitHub Issues.
 */
const required=[
  "ATE_POC_URL","ATE_POC_ANON_KEY",
  "ATE_POC_A_EMAIL","ATE_POC_A_PASSWORD",
  "ATE_POC_B_EMAIL","ATE_POC_B_PASSWORD",
  "ATE_POC_C_EMAIL","ATE_POC_C_PASSWORD",
];
for(const key of required)if(!process.env[key])throw Error("Missing required local test input: "+key);
const base=new URL(process.env.ATE_POC_URL);
if(base.protocol!=="https:" || !/^[a-z0-9-]+\.supabase\.co$/i.test(base.hostname) ||
   base.pathname!=="/" || base.search || base.hash)
  throw Error("Only isolated public HTTPS Supabase test-project URLs are supported");
const key=process.env.ATE_POC_ANON_KEY;
if(key.startsWith("sb_secret_"))throw Error("Service-role/secret key prohibited");
if(!key.startsWith("sb_publishable_")){
  const parts=key.split(".");
  if(parts.length!==3 || JSON.parse(Buffer.from(parts[1],"base64url")).role!=="anon")
    throw Error("Only public anon keys are supported");
}

async function request(path,method,token,body){
  const response=await fetch(base.origin+"/"+path,{
    method,
    headers:{apikey:key,Authorization:"Bearer "+token,
      Accept:"application/json",...(body===undefined?{}:{"Content-Type":"application/json"}),
      Prefer:"return=representation"},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    redirect:"error",signal:AbortSignal.timeout(20_000),
  });
  const text=await response.text();
  return {ok:response.ok,status:response.status,
    value:response.ok && text ? JSON.parse(text):null};
}
async function login(who){
  const credentials={email:process.env[`ATE_POC_${who}_EMAIL`],
    password:process.env[`ATE_POC_${who}_PASSWORD`]};
  const result=await request("auth/v1/token?grant_type=password","POST",key,credentials);
  if(!result.ok || !result.value?.access_token)throw Error("Test account login failed for "+who);
  return result.value.access_token;
}
const a=await login("A"), b=await login("B"), c=await login("C");
const created=await request("rest/v1/rpc/ate_create_workspace","POST",a,{
  p_name:"AtE RLS smoke "+new Date().toISOString(),p_display_name:"Owner A",
});
if(!created.ok || typeof created.value!=="string")throw Error("Workspace creation failed");
const id=created.value;
const invite=await request("rest/v1/rpc/ate_create_invite","POST",a,{p_workspace:id});
if(!invite.ok || typeof invite.value!=="string")throw Error("Owner invite creation failed");
const joined=await request("rest/v1/rpc/ate_join_workspace","POST",b,{
  p_token:invite.value,p_display_name:"Member B",
});
if(!joined.ok || joined.value!==id)throw Error("Member B could not join");
const posted=await request("rest/v1/ate_workspace_messages","POST",a,{
  workspace_id:id,author_id:JSON.parse(Buffer.from(a.split(".")[1],"base64url")).sub,
  body:"RLS smoke message",
});
if(!posted.ok)throw Error("Owner message insert failed");
const viewB=await request(
  `rest/v1/ate_workspace_messages?workspace_id=eq.${id}&select=body`,"GET",b);
if(!viewB.ok || !Array.isArray(viewB.value) ||
   !viewB.value.some(row=>row.body==="RLS smoke message"))
  throw Error("Member B cannot read own workspace messages");
const viewC=await request(
  `rest/v1/ate_workspace_messages?workspace_id=eq.${id}&select=body`,"GET",c);
if(!viewC.ok || !Array.isArray(viewC.value) || viewC.value.length!==0)
  throw Error("RLS FAILED: outsider C could read workspace messages");
const outsiderWrite=await request("rest/v1/ate_workspace_messages","POST",c,{
  workspace_id:id,author_id:JSON.parse(Buffer.from(c.split(".")[1],"base64url")).sub,
  body:"This must be rejected",
});
if(outsiderWrite.ok)throw Error("RLS FAILED: outsider C wrote to the workspace");
console.log("PASS: two authenticated team users can share messages; outsider cannot read or write.");
console.log("Test workspace ID:",id);
console.log("This script created data in the test project; clean it up using test-project administration.");
