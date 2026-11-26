import {randomUUID} from "node:crypto";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {
  AI_PROJECT_ACTIONS,AI_PROJECT_IMPLEMENTED_ACTIONS,
  parseAIProjectCreate,parseAIProjectRename,parseAIProjectId,
  parseAIProjectSourceGrant,parseAIProjectSourceRevoke,parseAIProjectActionGrant,
  type AIProject,type AIProjectAction,type AIProjectActionGrant,
  type AIProjectAuditEvent,type AIProjectAuditKind,type AIProjectCreateInput,
  type AIProjectDestination,type AIProjectSourceGrant,type AIProjectSourceType,
} from "../../shared/ai-project-model";

interface ProjectRow{id:string;name:string;purpose:string;created_at:string;updated_at:string;archived_at:string|null;}
interface SourceRow{
  project_id:string;source_type:AIProjectSourceType;source_id:string;
  can_read_local:number;can_send_remote:number;expires_at:string|null;
  created_at:string;updated_at:string;revoked_at:string|null;
}
interface ActionRow{
  project_id:string;action:AIProjectAction;enabled:number;expires_at:string|null;updated_at:string;
}
const IMPLEMENTED=new Set<AIProjectAction>(AI_PROJECT_IMPLEMENTED_ACTIONS);
const MAX_PROJECTS=50,MAX_GRANTS=100,MAX_EXPIRY_DAYS=366;
function project(row:ProjectRow):AIProject{
  return {id:row.id,name:row.name,purpose:row.purpose,createdAt:row.created_at,
    updatedAt:row.updated_at,archivedAt:row.archived_at};
}
function sourceGrant(row:SourceRow):AIProjectSourceGrant{
  return {projectId:row.project_id,sourceType:row.source_type,sourceId:row.source_id,
    canReadLocal:row.can_read_local===1,canSendRemote:row.can_send_remote===1,
    expiresAt:row.expires_at,createdAt:row.created_at,updatedAt:row.updated_at,
    revokedAt:row.revoked_at};
}
function utc(now:Date):string{
  if(!Number.isFinite(now.getTime()))throw Error("Invalid permission clock");
  return now.toISOString();
}
function validateExpiry(value:string|null,now:Date):void{
  if(value===null)return;
  const end=Date.parse(value),start=now.getTime();
  if(!Number.isFinite(end)||end<=start||end>start+MAX_EXPIRY_DAYS*86_400_000)
    throw Error("Permission expiry must be in the future and within 366 days");
}

/** Local-only AI project registry. Stores permission metadata, never source text or credentials. */
export class AIProjectStore{
  private readonly db:DatabaseSync;
  constructor(path:string){
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    const version=Number((this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version);
    if(version>1){this.db.close();throw Error("AI project database is newer than this application");}
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS ai_projects("+
      "id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL,"+
      "created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);"+
      "CREATE TABLE IF NOT EXISTS ai_project_source_grants("+
      "project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,"+
      "source_type TEXT NOT NULL CHECK(source_type='task'),source_id TEXT NOT NULL,"+
      "can_read_local INTEGER NOT NULL CHECK(can_read_local IN (0,1)),"+
      "can_send_remote INTEGER NOT NULL CHECK(can_send_remote IN (0,1)),"+
      "expires_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revoked_at TEXT,"+
      "PRIMARY KEY(project_id,source_type,source_id),"+
      "CHECK(can_send_remote=0 OR can_read_local=1));"+
      "CREATE INDEX IF NOT EXISTS ai_project_grants_by_source "+
      "ON ai_project_source_grants(source_type,source_id);"+
      "CREATE TABLE IF NOT EXISTS ai_project_action_grants("+
      "project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,"+
      "action TEXT NOT NULL CHECK(action IN ("+
      "'planning.propose','task.write','calendar.write','mail.send','file.write','external.tool')),"+
      "enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),expires_at TEXT,updated_at TEXT NOT NULL,"+
      "PRIMARY KEY(project_id,action));"+
      "CREATE TABLE IF NOT EXISTS ai_project_audit("+
      "id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,"+
      "kind TEXT NOT NULL,source_type TEXT,source_id TEXT,action TEXT,"+
      "destination TEXT,result TEXT NOT NULL CHECK(result IN ('recorded','allowed','denied')),"+
      "occurred_at TEXT NOT NULL);"+
      "CREATE INDEX IF NOT EXISTS ai_project_audit_recent "+
      "ON ai_project_audit(project_id,occurred_at DESC);"
    );
    if(version===0)this.db.exec("PRAGMA user_version=1");
  }
  close():void{this.db.close();}
  private transaction<T>(work:()=>T):T{
    this.db.exec("BEGIN IMMEDIATE");
    try{const result=work();this.db.exec("COMMIT");return result;}
    catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private requireProject(id:string,allowArchived=false):ProjectRow{
    const row=this.db.prepare("SELECT * FROM ai_projects WHERE id=?").get(id) as ProjectRow|undefined;
    if(!row||(!allowArchived&&row.archived_at!==null))
      throw Error("AI project is unavailable or archived");
    return row;
  }
  private audit(projectId:string,kind:AIProjectAuditKind,now:string,
    fields:{sourceType?:AIProjectSourceType;sourceId?:string;action?:AIProjectAction;
      destination?:AIProjectDestination;result?:"recorded"|"allowed"|"denied"}={}):void{
    this.db.prepare("INSERT INTO ai_project_audit "+
      "(id,project_id,kind,source_type,source_id,action,destination,result,occurred_at) "+
      "VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),projectId,kind,
      fields.sourceType??null,fields.sourceId??null,fields.action??null,
      fields.destination??null,fields.result??"recorded",now);
  }
  createProject(input:unknown,now=new Date()):AIProject{
    const value=parseAIProjectCreate(input),stamp=utc(now);
    return this.transaction(()=>{
      const count=Number((this.db.prepare("SELECT COUNT(*) AS n FROM ai_projects").get() as {n:number}).n);
      if(count>=MAX_PROJECTS)throw Error("A maximum of 50 local AI projects is supported");
      const id=randomUUID();
      this.db.prepare("INSERT INTO ai_projects(id,name,purpose,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(id,value.name,value.purpose,stamp,stamp);
      this.audit(id,"project.created",stamp);
      return this.getProject(id)!;
    });
  }
  listProjects():AIProject[]{
    return (this.db.prepare("SELECT * FROM ai_projects ORDER BY archived_at IS NOT NULL,updated_at DESC")
      .all() as ProjectRow[]).map(project);
  }
  getProject(rawId:unknown):AIProject|null{
    const id=parseAIProjectId(rawId);
    const row=this.db.prepare("SELECT * FROM ai_projects WHERE id=?").get(id) as ProjectRow|undefined;
    return row?project(row):null;
  }
  renameProject(input:unknown,now=new Date()):AIProject{
    const value=parseAIProjectRename(input),stamp=utc(now);
    return this.transaction(()=>{
      this.requireProject(value.id);
      this.db.prepare("UPDATE ai_projects SET name=?,purpose=?,updated_at=? WHERE id=?")
        .run(value.name,value.purpose,stamp,value.id);
      this.audit(value.id,"project.renamed",stamp);
      return this.getProject(value.id)!;
    });
  }
  archiveProject(rawId:unknown,now=new Date()):AIProject{
    const id=parseAIProjectId(rawId),stamp=utc(now);
    return this.transaction(()=>{
      this.requireProject(id);
      this.db.prepare("UPDATE ai_projects SET archived_at=?,updated_at=? WHERE id=?")
        .run(stamp,stamp,id);
      this.db.prepare("UPDATE ai_project_source_grants SET can_read_local=0,"+
        "can_send_remote=0,revoked_at=?,updated_at=? WHERE project_id=? AND revoked_at IS NULL")
        .run(stamp,stamp,id);
      this.db.prepare("UPDATE ai_project_action_grants SET enabled=0,updated_at=? WHERE project_id=?")
        .run(stamp,id);
      this.audit(id,"project.archived",stamp);
      return this.getProject(id)!;
    });
  }
  listSourceGrants(rawProjectId:unknown):AIProjectSourceGrant[]{
    const id=parseAIProjectId(rawProjectId);this.requireProject(id,true);
    return (this.db.prepare("SELECT * FROM ai_project_source_grants "+
      "WHERE project_id=? ORDER BY source_type,source_id").all(id) as SourceRow[]).map(sourceGrant);
  }
  setSourceGrant(input:unknown,now=new Date()):AIProjectSourceGrant{
    const value=parseAIProjectSourceGrant(input),stamp=utc(now);validateExpiry(value.expiresAt,now);
    return this.transaction(()=>{
      this.requireProject(value.projectId);
      const prior=this.db.prepare("SELECT * FROM ai_project_source_grants "+
        "WHERE project_id=? AND source_type=? AND source_id=?")
        .get(value.projectId,value.sourceType,value.sourceId) as SourceRow|undefined;
      if(!prior){
        const count=Number((this.db.prepare("SELECT COUNT(*) AS n "+
          "FROM ai_project_source_grants WHERE project_id=?").get(value.projectId) as {n:number}).n);
        if(count>=MAX_GRANTS)throw Error("A project can contain at most 100 source grants");
      }
      this.db.prepare("INSERT INTO ai_project_source_grants("+
        "project_id,source_type,source_id,can_read_local,can_send_remote,expires_at,"+
        "created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL) "+
        "ON CONFLICT(project_id,source_type,source_id) DO UPDATE SET "+
        "can_read_local=excluded.can_read_local,can_send_remote=excluded.can_send_remote,"+
        "expires_at=excluded.expires_at,updated_at=excluded.updated_at,revoked_at=NULL")
        .run(value.projectId,value.sourceType,value.sourceId,Number(value.canReadLocal),
          Number(value.canSendRemote),value.expiresAt,prior?.created_at??stamp,stamp);
      this.db.prepare("UPDATE ai_projects SET updated_at=? WHERE id=?").run(stamp,value.projectId);
      this.audit(value.projectId,"source.grant.updated",stamp,
        {sourceType:value.sourceType,sourceId:value.sourceId});
      return sourceGrant(this.db.prepare("SELECT * FROM ai_project_source_grants "+
        "WHERE project_id=? AND source_type=? AND source_id=?")
        .get(value.projectId,value.sourceType,value.sourceId) as SourceRow);
    });
  }
  revokeSourceGrant(input:unknown,now=new Date()):{revoked:boolean}{
    const value=parseAIProjectSourceRevoke(input),stamp=utc(now);
    return this.transaction(()=>{
      this.requireProject(value.projectId);
      const result=this.db.prepare("UPDATE ai_project_source_grants SET "+
        "can_read_local=0,can_send_remote=0,revoked_at=?,updated_at=? "+
        "WHERE project_id=? AND source_type=? AND source_id=? AND revoked_at IS NULL")
        .run(stamp,stamp,value.projectId,value.sourceType,value.sourceId);
      if(Number(result.changes)>0)this.audit(value.projectId,"source.grant.revoked",stamp,
        {sourceType:value.sourceType,sourceId:value.sourceId});
      return {revoked:Number(result.changes)>0};
    });
  }
  listActionGrants(rawProjectId:unknown):AIProjectActionGrant[]{
    const id=parseAIProjectId(rawProjectId),owner=this.requireProject(id,true);
    const rows=this.db.prepare("SELECT * FROM ai_project_action_grants WHERE project_id=?")
      .all(id) as ActionRow[];
    const byAction=new Map(rows.map(row=>[row.action,row]));
    return AI_PROJECT_ACTIONS.map(action=>{
      const row=byAction.get(action);
      const active=owner.archived_at===null&&row?.enabled===1&&
        (!row.expires_at||Date.parse(row.expires_at)>Date.now());
      return {projectId:id,action,enabled:!!active,expiresAt:row?.expires_at??null,
        updatedAt:row?.updated_at??owner.updated_at,available:IMPLEMENTED.has(action)};
    });
  }
  setActionGrant(input:unknown,now=new Date()):AIProjectActionGrant{
    const value=parseAIProjectActionGrant(input),stamp=utc(now);validateExpiry(value.expiresAt,now);
    if(value.enabled&&!IMPLEMENTED.has(value.action))
      throw Error("This AI action is not implemented and cannot be granted");
    return this.transaction(()=>{
      this.requireProject(value.projectId);
      this.db.prepare("INSERT INTO ai_project_action_grants "+
        "(project_id,action,enabled,expires_at,updated_at) VALUES(?,?,?,?,?) "+
        "ON CONFLICT(project_id,action) DO UPDATE SET enabled=excluded.enabled,"+
        "expires_at=excluded.expires_at,updated_at=excluded.updated_at")
        .run(value.projectId,value.action,Number(value.enabled),value.expiresAt,stamp);
      this.db.prepare("UPDATE ai_projects SET updated_at=? WHERE id=?").run(stamp,value.projectId);
      this.audit(value.projectId,"action.grant.updated",stamp,{action:value.action});
      return this.listActionGrants(value.projectId).find(x=>x.action===value.action)!;
    });
  }
  authorizeSources(rawProjectId:unknown,sourceType:AIProjectSourceType,
    sourceIds:readonly string[],destination:AIProjectDestination,now=new Date()):void{
    const id=parseAIProjectId(rawProjectId),stamp=utc(now);
    if(sourceType!=="task"||!Array.isArray(sourceIds)||sourceIds.length<1||
      sourceIds.length>8||new Set(sourceIds).size!==sourceIds.length||
      sourceIds.some(x=>typeof x!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)))
      throw Error("Invalid AI project source scope");
    if(destination!=="local"&&destination!=="cloud-model")throw Error("Invalid AI project destination");
    const allowed=this.transaction(()=>{
      this.requireProject(id);
      let result=true;
      for(const sourceId of sourceIds){
        const row=this.db.prepare("SELECT * FROM ai_project_source_grants "+
          "WHERE project_id=? AND source_type=? AND source_id=?")
          .get(id,sourceType,sourceId.toLowerCase()) as SourceRow|undefined;
        const valid=!!row&&row.revoked_at===null&&
          (!row.expires_at||Date.parse(row.expires_at)>now.getTime())&&
          row.can_read_local===1&&(destination==="local"||row.can_send_remote===1);
        this.audit(id,"source.access",stamp,{sourceType,sourceId:sourceId.toLowerCase(),
          destination,result:valid?"allowed":"denied"});
        if(!valid)result=false;
      }
      return result;
    });
    if(!allowed)throw Error(destination==="cloud-model"
      ?"Project permission required: explicitly allow local reading and cloud-model transmission for every selected task"
      :"Project permission required: explicitly allow local reading for every selected task");
  }
  authorizeAction(rawProjectId:unknown,action:AIProjectAction,now=new Date()):void{
    const id=parseAIProjectId(rawProjectId),stamp=utc(now);
    if(!AI_PROJECT_ACTIONS.includes(action))throw Error("Unsupported AI project action");
    const allowed=this.transaction(()=>{
      const owner=this.requireProject(id);
      const row=this.db.prepare("SELECT * FROM ai_project_action_grants "+
        "WHERE project_id=? AND action=?").get(id,action) as ActionRow|undefined;
      const valid=owner.archived_at===null&&IMPLEMENTED.has(action)&&row?.enabled===1&&
        (!row.expires_at||Date.parse(row.expires_at)>now.getTime());
      this.audit(id,"action.access",stamp,{action,result:valid?"allowed":"denied"});
      return valid;
    });
    if(!allowed)throw Error("Project action permission required: "+action);
  }
  auditEvents(rawProjectId:unknown,limit=30):AIProjectAuditEvent[]{
    const id=parseAIProjectId(rawProjectId);this.requireProject(id,true);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error("Invalid AI project audit limit");
    const rows=this.db.prepare("SELECT * FROM ai_project_audit "+
      "WHERE project_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?").all(id) as
      {id:string;project_id:string;kind:AIProjectAuditKind;source_type:AIProjectSourceType|null;
       source_id:string|null;action:AIProjectAction|null;destination:AIProjectDestination|null;
       result:"recorded"|"allowed"|"denied";occurred_at:string}[];
    return rows.map(row=>({id:row.id,projectId:row.project_id,kind:row.kind,
      sourceType:row.source_type,sourceId:row.source_id,action:row.action,
      destination:row.destination,result:row.result,occurredAt:row.occurred_at}));
  }
}
