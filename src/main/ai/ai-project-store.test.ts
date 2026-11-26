import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AIProjectStore} from "./ai-project-store";
import {AI_PROJECT_ACTIONS,parseAIProjectSourceGrant} from "../../shared/ai-project-model";

const now=new Date("2026-11-26T00:00:00.000Z");
let projectId="";
const taskId="ec926d48-ac41-46a1-8a4c-e9308b32b302";
const stores:AIProjectStore[]=[];
function store(){const value=new AIProjectStore(":memory:");stores.push(value);return value;}
function create(db:AIProjectStore){
  const created=db.createProject({name:"Coursework",purpose:"Prepare my weekly study plan"},now);
  projectId=created.id;
  return created;
}
function grant(db:AIProjectStore,options:Partial<{
  canReadLocal:boolean;canSendRemote:boolean;expiresAt:string|null;
}>={}){
  return db.setSourceGrant({projectId,sourceType:"task",sourceId:taskId,
    canReadLocal:true,canSendRemote:true,expiresAt:null,...options},now);
}
afterEach(()=>{while(stores.length)stores.pop()!.close();});

describe("local AI project authorization registry",()=>{
  it("creates personal local projects and persists no content or credentials in audit events",()=>{
    const db=store(),created=create(db);
    expect(created).toMatchObject({name:"Coursework",purpose:"Prepare my weekly study plan",archivedAt:null});
    expect(db.listProjects()).toHaveLength(1);
    const events=db.auditEvents(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({kind:"project.created",result:"recorded"});
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(()=>db.createProject({name:"",purpose:""},now)).toThrow();
    expect(()=>db.createProject({name:"x",purpose:"",apiKey:"secret"},now)).toThrow();
  });
  it("requires local-read and remote-inference grants separately for cloud context",()=>{
    const db=store();create(db);
    grant(db,{canReadLocal:true,canSendRemote:false});
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"local",now)).not.toThrow();
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",now))
      .toThrow("cloud-model transmission");
    grant(db,{canReadLocal:true,canSendRemote:true});
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",now)).not.toThrow();
    const results=db.auditEvents(projectId).filter(x=>x.kind==="source.access").map(x=>x.result);
    expect(results).toContain("allowed");
    expect(results).toContain("denied");
  });
  it("denies implicit, expired and revoked grants, and permits explicit re-authorization",()=>{
    const db=store();create(db);
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",now)).toThrow();
    grant(db,{expiresAt:"2026-11-26T01:00:00.000Z"});
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",now)).not.toThrow();
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",
      new Date("2026-11-26T01:00:00.001Z"))).toThrow();
    expect(db.revokeSourceGrant({projectId,sourceType:"task",sourceId:taskId},now))
      .toEqual({revoked:true});
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"local",now)).toThrow();
    grant(db);
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",now)).not.toThrow();
  });
  it("rejects remote send without local read, malformed resource scope and oversized grant lists",()=>{
    expect(()=>parseAIProjectSourceGrant({projectId,sourceType:"task",sourceId:taskId,
      canReadLocal:false,canSendRemote:true,expiresAt:null})).toThrow();
    const db=store();create(db);grant(db);
    expect(()=>db.authorizeSources(projectId,"task",[taskId,taskId],"cloud-model",now)).toThrow();
    expect(()=>db.authorizeSources(projectId,"task",[],"cloud-model",now)).toThrow();
    expect(()=>db.authorizeSources(projectId,"mail-message" as never,[taskId],"cloud-model",now)).toThrow();
  });
  it("keeps every high-impact action denied by default and only grants the implemented draft action",()=>{
    const db=store();create(db);
    expect(db.listActionGrants(projectId,now).filter(x=>x.enabled)).toHaveLength(0);
    expect(db.listActionGrants(projectId,now)).toHaveLength(AI_PROJECT_ACTIONS.length);
    expect(()=>db.authorizeAction(projectId,"planning.propose",now)).toThrow();
    expect(()=>db.setActionGrant({projectId,action:"mail.send",enabled:true,expiresAt:null},now)).toThrow("not implemented");
    const action=db.setActionGrant({
      projectId,action:"planning.propose",enabled:true,expiresAt:"2026-11-27T00:00:00.000Z",
    },now);
    expect(action).toMatchObject({enabled:true,available:true});
    expect(()=>db.authorizeAction(projectId,"planning.propose",now)).not.toThrow();
    expect(()=>db.authorizeAction(projectId,"planning.propose",
      new Date("2026-11-27T00:00:00.000Z"))).toThrow();
  });
  it("archives atomically, revokes all grants and retains an audit trail",()=>{
    const db=store();create(db);grant(db);
    db.setActionGrant({projectId,action:"planning.propose",enabled:true,expiresAt:null},now);
    const archived=db.archiveProject(projectId,now);
    expect(archived.archivedAt).toBe(now.toISOString());
    expect(db.listSourceGrants(projectId)[0]).toMatchObject({
      canReadLocal:false,canSendRemote:false,revokedAt:now.toISOString(),
    });
    expect(db.listActionGrants(projectId,now).every(x=>!x.enabled)).toBe(true);
    expect(()=>db.authorizeSources(projectId,"task",[taskId],"cloud-model",now)).toThrow();
    expect(()=>db.authorizeAction(projectId,"planning.propose",now)).toThrow();
    expect(()=>db.renameProject({id:projectId,name:"Renamed",purpose:""},now)).toThrow("archived");
    expect(db.auditEvents(projectId).some(x=>x.kind==="project.archived")).toBe(true);
  });
  it("persists projects and grants across a local database reopen",()=>{
    const dir=mkdtempSync(join(tmpdir(),"study-anchor-ai-project-"));
    const path=join(dir,"projects.sqlite");
    try{
      const first=new AIProjectStore(path);
      let created:ReturnType<AIProjectStore["createProject"]>;
      try{
        created=first.createProject({name:"Persistent",purpose:"Local only"},now);
        first.setSourceGrant({projectId:created.id,sourceType:"task",sourceId:taskId,
          canReadLocal:true,canSendRemote:true,expiresAt:null},now);
        first.setActionGrant({projectId:created.id,action:"planning.propose",
          enabled:true,expiresAt:null},now);
      }finally{first.close();}
      const reopened=new AIProjectStore(path);
      try{
        expect(reopened.listProjects()[0]).toMatchObject({id:created.id,name:"Persistent"});
        expect(reopened.listSourceGrants(created.id)[0]).toMatchObject({
          sourceId:taskId,canReadLocal:true,canSendRemote:true,
        });
        expect(reopened.listActionGrants(created.id,now).find(x=>x.action==="planning.propose")?.enabled)
          .toBe(true);
        expect(reopened.auditEvents(created.id).length).toBeGreaterThanOrEqual(3);
      }finally{reopened.close();}
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("enforces expiry bounds, exact schemas and the per-project grant ceiling",()=>{
    const db=store();create(db);
    expect(()=>grant(db,{expiresAt:"2026-11-25T23:59:59.000Z"})).toThrow();
    expect(()=>grant(db,{expiresAt:"2028-01-01T00:00:00.000Z"})).toThrow();
    expect(()=>db.renameProject({id:projectId,name:"Renamed",purpose:"",extra:true},now)).toThrow();
    for(let i=0;i<100;i++){
      const id=String(i+1).padStart(8,"0")+"-ac41-46a1-8a4c-e9308b32b301";
      db.setSourceGrant({projectId,sourceType:"task",sourceId:id,
        canReadLocal:true,canSendRemote:false,expiresAt:null},now);
    }
    expect(()=>db.setSourceGrant({projectId,sourceType:"task",
      sourceId:"fc926d48-ac41-46a1-8a4c-e9308b32b303",
      canReadLocal:true,canSendRemote:false,expiresAt:null},now)).toThrow("100 source grants");
  });
});
