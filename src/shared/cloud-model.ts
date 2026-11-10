/** Test-project-only Supabase/PostgREST boundary. Never use a service_role key. */
export interface CloudProjectConfig { projectUrl:string; publishableKey:string; }
export interface CloudCredentials { email:string; password:string; }
export interface CloudSessionStatus {
  configured:boolean;
  authenticated:boolean;
  userId:string|null;
  email:string|null;
}
export interface SharedWorkspace { id:string; name:string; created_at:string; }
export interface SharedMember {
  workspace_id:string; user_id:string; role:"owner"|"member";
  display_name:string; joined_at:string;
}
export interface SharedMessage {
  id:string;workspace_id:string;author_id:string;body:string;created_at:string;
}
export interface SharedTask {
  id:string;workspace_id:string;created_by:string;title:string;
  due_date:string|null;assigned_to:string|null;completed:boolean;
  created_at:string;updated_at:string;
}
export interface SharedTaskInput {
  title:string;dueDate?:string|null;assignedTo?:string|null;
}
export const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(input:unknown):string {
  if(typeof input!=="string" || !UUID_RE.test(input)) throw Error("Invalid cloud identifier");
  return input;
}
export function requireDisplayName(input:unknown):string {
  if(typeof input!=="string" || !input.trim() || input.trim().length>60)
    throw Error("Display name must have 1–60 characters");
  return input.trim();
}
export function requireWorkspaceName(input:unknown):string {
  if(typeof input!=="string" || !input.trim() || input.trim().length>120)
    throw Error("Workspace name must have 1–120 characters");
  return input.trim();
}
export function requireCloudMessage(input:unknown):string {
  if(typeof input!=="string" || !input.trim() || input.length>2000)
    throw Error("Message must have 1–2000 characters");
  return input.trim();
}
export function requireInvite(input:unknown):string {
  if(typeof input!=="string" || !/^[0-9a-f]{48}$/.test(input))
    throw Error("Invalid workspace invitation");
  return input;
}
export function requireCloudCredentials(input:unknown):CloudCredentials {
  if(!input || typeof input!=="object" || Array.isArray(input))
    throw Error("Invalid account input");
  const x=input as Record<string,unknown>;
  if(Object.keys(x).some(k=>!["email","password"].includes(k)))
    throw Error("Unexpected account field");
  if(typeof x.email!=="string" || x.email.length>254 ||
     !/^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,63}$/.test(x.email))
    throw Error("Invalid account email");
  if(typeof x.password!=="string" || x.password.length<8 || x.password.length>256)
    throw Error("Password must contain 8–256 characters");
  return {email:x.email.trim().toLowerCase(),password:x.password};
}
export function parseCloudTask(input:unknown):SharedTaskInput {
  if(!input || typeof input!=="object" || Array.isArray(input)) throw Error("Invalid shared task");
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!["title","dueDate","assignedTo"].includes(key)))
    throw Error("Unexpected shared task field");
  const title=requireWorkspaceName(value.title);
  const dueDate=value.dueDate===undefined ? null : value.dueDate;
  if(dueDate!==null &&
     (typeof dueDate!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      !Number.isFinite(Date.parse(dueDate+"T00:00:00Z")) ||
      new Date(dueDate+"T00:00:00Z").toISOString().slice(0,10)!==dueDate))
    throw Error("Invalid shared due date");
  const assignedTo=value.assignedTo===undefined || value.assignedTo===null
    ? null : requireUuid(value.assignedTo);
  return {title,dueDate:dueDate as string|null,assignedTo};
}

/** Never allow a privileged service key into the desktop client. */
export function validateCloudProject(input:unknown):CloudProjectConfig {
  if(!input || typeof input!=="object" || Array.isArray(input))throw Error("Invalid cloud config");
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(k=>!["projectUrl","publishableKey"].includes(k)))
    throw Error("Unexpected cloud config field");
  if(typeof value.projectUrl!=="string" || value.projectUrl.length>500)
    throw Error("Cloud project URL is required");
  let url:URL;
  try {url=new URL(value.projectUrl);} catch {throw Error("Invalid cloud project URL");}
  if(url.protocol!=="https:" || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) ||
     url.username || url.password || url.port || url.pathname!=="/" ||
     url.search || url.hash) throw Error("Only standard public Supabase HTTPS project URLs are accepted");
  if(typeof value.publishableKey!=="string" || value.publishableKey.length>4096 ||
     value.publishableKey.startsWith("sb_secret_"))throw Error("Secret keys are prohibited");
  const key=value.publishableKey;
  if(!/^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(key)){
    const parts=key.split(".");
    if(parts.length!==3)throw Error("Expected a Supabase publishable or legacy anon key");
    try {
      const payload=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
      if(payload.role!=="anon")throw Error("Only anon keys are permitted");
    } catch {throw Error("Only anon keys are permitted");}
  }
  return {projectUrl:url.origin,publishableKey:key};
}
