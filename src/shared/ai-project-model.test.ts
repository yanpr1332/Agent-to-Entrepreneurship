import {describe,expect,it} from "vitest";
import {
  parseAIProjectCreate,parseAIProjectRename,parseAIProjectSourceGrant,
  parseAIProjectSourceRevoke,parseAIProjectActionGrant,parseAIProjectId,
} from "./ai-project-model";
const project="dc926d48-ac41-46a1-8a4c-e9308b32b301";
const task="ec926d48-ac41-46a1-8a4c-e9308b32b302";
describe("strict AI project IPC contracts",()=>{
  it("normalizes project names and rejects extra fields, blank names and invalid IDs",()=>{
    expect(parseAIProjectCreate({name:"  Exam prep  ",purpose:"  Revision  "}))
      .toEqual({name:"Exam prep",purpose:"Revision"});
    expect(parseAIProjectRename({id:project,name:"New",purpose:""}))
      .toMatchObject({id:project,name:"New"});
    expect(()=>parseAIProjectCreate({name:"",purpose:""})).toThrow();
    expect(()=>parseAIProjectCreate({name:"Valid",purpose:"",ownerId:"forged"})).toThrow();
    expect(()=>parseAIProjectId("not-a-uuid")).toThrow();
  });
  it("requires local-read before remote-inference and a non-empty grant",()=>{
    const valid={projectId:project,sourceType:"task",sourceId:task,
      canReadLocal:true,canSendRemote:true,expiresAt:null};
    expect(parseAIProjectSourceGrant(valid)).toMatchObject({canReadLocal:true,canSendRemote:true});
    expect(()=>parseAIProjectSourceGrant({...valid,canReadLocal:false})).toThrow();
    expect(()=>parseAIProjectSourceGrant({...valid,canReadLocal:false,canSendRemote:false})).toThrow();
    expect(()=>parseAIProjectSourceGrant({...valid,sourceType:"mail-message"})).toThrow();
  });
  it("requires canonical UTC expiries and exact revoke/action payloads",()=>{
    const valid={projectId:project,sourceType:"task",sourceId:task,
      canReadLocal:true,canSendRemote:false,expiresAt:"2026-11-27T00:00:00.000Z"};
    expect(parseAIProjectSourceGrant(valid).expiresAt).toBe(valid.expiresAt);
    expect(()=>parseAIProjectSourceGrant({...valid,expiresAt:"2026-11-27"})).toThrow();
    expect(parseAIProjectSourceRevoke({projectId:project,sourceType:"task",sourceId:task}))
      .toMatchObject({projectId:project,sourceId:task});
    expect(()=>parseAIProjectSourceRevoke({projectId:project,sourceType:"task",sourceId:task,all:true})).toThrow();
    expect(parseAIProjectActionGrant({projectId:project,action:"planning.propose",
      enabled:true,expiresAt:null})).toMatchObject({action:"planning.propose",enabled:true});
    expect(()=>parseAIProjectActionGrant({projectId:project,action:"shell.exec",
      enabled:true,expiresAt:null})).toThrow();
  });
});
