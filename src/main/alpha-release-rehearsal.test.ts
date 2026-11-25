import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";
import { KnowledgeStore } from "./knowledge-store";
import { PlanningStore } from "./planning-store";
import { FixedCalendarStore } from "./fixed-calendar-store";
import { CampusMailStore } from "./connectors/mail-store";
import { CampusMailDraftVault } from "./connectors/mail-drafts";
import { CanvasSyncService } from "./connectors/canvas-sync";
import type { CanvasApi } from "./connectors/canvas-api";
import { AIKeyVault } from "./ai/ai-vault";
import { AIUsageLedger } from "./ai/ai-usage";
import { AIService } from "./ai/ai-service";
import { WorkspaceHistoryStore } from "./cloud/workspace-history-store";
import { testHistoryCipher } from "./cloud/workspace-history-crypto.test-helper";
import { createLocalBackup } from "./local-backup";
import { inspectRecoveryFolder, recoverToNewProfile } from "./profile-recovery";
import { workbenchTaskSummary,workbenchDaySchedule } from "../shared/workbench-data";
import type { EncryptionProvider } from "./connectors/canvas-credentials";

/**
 * Offline E2E rehearsal across REAL SQLite stores and public service APIs.
 * All identities, emails and API responses are synthetic. No network, GUI,
 * real credentials, model provider, SMTP or Supabase deployment is touched.
 * This complements but does not replace live V0.1 acceptance.
 */
const dirs:string[]=[];
const opened:{close():void}[]=[];
function track<T extends {close():void}>(value:T):T{opened.push(value);return value;}
afterEach(()=>{
  while(opened.length){try{opened.pop()!.close();}catch{/* closed by test */}}
  while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});
});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"sa-alpha-rc-"));
  dirs.push(root);
  const live=join(root,"live");
  mkdirSync(live);
  const tasks=track(new LocalStore(join(live,"study-anchor-tasks.sqlite")));
  const knowledge=track(new KnowledgeStore(join(live,"study-anchor-knowledge.sqlite")));
  const mail=track(new CampusMailStore(join(live,"study-anchor-mail.sqlite")));
  let engine:CanvasSyncService;
  const calendar=track(new FixedCalendarStore(join(live,"study-anchor-calendar.sqlite"),
    ()=>[],()=>engine.scope()));
  const planning=track(new PlanningStore(join(live,"study-anchor-planning.sqlite"),
    ()=>calendar.busySlots()));
  const encrypted:EncryptionProvider={
    isAsyncEncryptionAvailable:async()=>true,
    encryptStringAsync:async text=>Buffer.from(text).reverse(),
    decryptStringAsync:async data=>({result:Buffer.from(data).reverse().toString("utf8"),shouldReEncrypt:false}),
  };
  return {root,live,tasks,knowledge,mail,calendar,planning,encrypted,
    attachCanvas:(service:CanvasSyncService)=>{engine=service;}};
}
function day(date:Date) {
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),
    String(date.getDate()).padStart(2,"0")].join("-");
}
function shiftDay(date:Date,number:number) {
  const copy=new Date(date);
  copy.setDate(copy.getDate()+number);
  return day(copy);
}
const ACCOUNT="student@sjtu.edu.cn";
const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const SPACE="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";

describe("ALPHA-RC real local eight-module rehearsal and isolated recovery",()=>{
  it("joins eight offline modules, persists five SQLite databases and restores exactly the snapshot",async()=>{
    const f=fixture();
    const now=new Date(),today=day(now),tomorrow=shiftDay(now,1),later=shiftDay(now,3);
    const own=f.tasks.createTask({title:"Synthetic personal revision",dueDate:later,priority:"high"});
    const imported=f.knowledge.importText({
      sourcePath:join(f.root,"synthetic-lecture.md"),title:"Synthetic Lecture",
      format:"markdown",text:"# Evidence\nDNA polymerase reads a template strand.",
    });
    const card=f.knowledge.createCard({documentId:imported.document.id,sourceOrdinal:0,
      question:"What does DNA polymerase read?",answer:"A template strand."});
    f.knowledge.reviewCard(card.id,"good",now);
    expect(f.knowledge.progress(now).reviewedToday).toBe(1);

    const headers=[{uid:10,uidValidity:22,from:"Instructor <teacher@sjtu.edu.cn>",
      subject:"Synthetic assignment notice",date:now.toISOString(),
      messageId:"<synthetic-10@sjtu.edu.cn>"}];
    f.mail.merge(ACCOUNT,22,headers,now);
    const mailRecord=f.mail.list(ACCOUNT)[0];
    const accepted=f.tasks.reviewMailCandidate(mailRecord,"accept");
    expect(accepted.created).toBe(true);
    expect(f.tasks.reviewMailCandidate(mailRecord,"accept").created).toBe(false);
    expect(f.tasks.listTasks()).toHaveLength(2);

    // Synthetic Canvas assignments and events enter the SAME task/calendar
    // stores as manual work. Repeated syncs must be idempotent.
    // Canvas civil-calendar slots require exact full-minute boundaries.
    const eventTime=new Date(now);
    eventTime.setDate(eventTime.getDate()+1);
    eventTime.setHours(9,0,0,0);
    const api={
      origin:"https://oc.sjtu.edu.cn",getCurrentUserId:async()=>91,
      listCourses:async()=>[{id:5,name:"Synthetic Course",courseCode:"SYN"}],
      listAssignments:async()=>[{id:18,courseId:5,name:"Canvas synthetic lab",
        dueAt:new Date(now.getTime()+3*86400000).toISOString(),
        htmlUrl:null,pointsPossible:50}],
      listCalendarEvents:async()=>[{id:23,courseId:5,title:"Synthetic lecture",
        startAt:eventTime.toISOString(),
        endAt:new Date(eventTime.getTime()+3600000).toISOString(),
        allDayDate:null}],
    } as unknown as CanvasApi;
    const canvas=new CanvasSyncService(f.tasks,async()=>api,()=>{},f.calendar);
    f.attachCanvas(canvas);
    expect(await canvas.sync()).toMatchObject({created:1,calendarCreated:1});
    expect((await canvas.sync()).created).toBe(0);
    expect(f.tasks.listTasks()).toHaveLength(3);
    expect(f.calendar.listCanvasEvents(api.origin,91)).toHaveLength(1);
    f.calendar.create({title:"Synthetic manual seminar",day:tomorrow,
      startMinute:900,durationMinutes:60,weeks:1});

    const proposal=f.planning.propose({startDate:tomorrow,days:5,dailyStart:"13:00",
      dailyEnd:"19:00",minutesPerTask:45},f.tasks.listTasks(),now);
    expect(proposal.blocks.length).toBeGreaterThan(0);
    const applied=f.planning.apply({proposalId:proposal.id,
      blockIds:[proposal.blocks[0].id],edits:[]},f.tasks.listTasks(),now);
    expect(applied.blocks).toHaveLength(1);
    expect(f.planning.listCommitted()).toHaveLength(1);

    f.tasks.recordFocusSession({sessionId:randomUUID(),plannedMinutes:25,
      elapsedSeconds:1500,title:"Synthetic focus"});
    const reward=f.tasks.createFocusReward({
      title:"Break",description:"Synthetic reward",cost:10,
    });
    const receipt=f.tasks.redeemFocusReward({redemptionId:randomUUID(),rewardId:reward.id});
    expect(receipt.cost).toBe(10);
    expect(f.tasks.focusRewards()).toMatchObject({earned:25,spent:10,available:15});

    // No model request occurs until explicit approval. External provider is a
    // deterministic fake, not a live paid AI / Canvas / mail account.
    const vault=new AIKeyVault(join(f.live,"study-anchor-ai.enc"),f.encrypted);
    const ledger=track(new AIUsageLedger(join(f.live,"study-anchor-ai-usage.sqlite")));
    const ask=vi.fn(async()=>({text:"Synthetic proposed revision",model:"gpt-4.1-mini",
      createdAt:now.toISOString(),usage:{inputTokens:12,outputTokens:9}}));
    const ai=new AIService(vault,ledger,{ask});
    await ai.connect({apiKey:"sk-"+ "x".repeat(40),model:"gpt-4.1-mini"});
    const preview=ai.prepare("Explain the selected synthetic excerpt");
    expect(ask).not.toHaveBeenCalled();
    expect((await ai.confirm(preview.approvalId)).text).toContain("Synthetic");
    expect(ask).toHaveBeenCalledTimes(1);

    const drafts=new CampusMailDraftVault(join(f.live,"study-anchor-mail-drafts.enc"),f.encrypted);
    await drafts.save(ACCOUNT,{to:[],subject:"Local secret draft",body:"Private draft plaintext"});
    const history=track(new WorkspaceHistoryStore(
      join(f.live,"study-anchor-team-history.sqlite"),testHistoryCipher));
    history.applyPage(OWNER,SPACE,{changes:[{cursor:"1",kind:"message",action:"upsert",
      entityId:"7c2cb69c-8b50-419c-8966-e8a55c397a11",record:{
        id:"7c2cb69c-8b50-419c-8966-e8a55c397a11",workspace_id:SPACE,
        author_id:OWNER,body:"Synthetic TEAM private content",created_at:now.toISOString(),
      }}],nextCursor:"1",serverCursor:"1",hasMore:false});
    expect(history.getCursor(OWNER,SPACE)).toBe("1");

    const dashboard=workbenchTaskSummary(f.tasks.listTasks(),today);
    expect(dashboard.pending).toBe(3);
    const schedule=workbenchDaySchedule(f.planning.listCommitted(),
      f.calendar.listForDisplay(),applied.blocks[0].day);
    expect(schedule.count).toBeGreaterThan(0);

    const snapshot=await createLocalBackup(f.live,[
      {name:"tasks",store:f.tasks},{name:"mail",store:f.mail},
      {name:"knowledge",store:f.knowledge},{name:"planning",store:f.planning},
      {name:"calendar",store:f.calendar},
    ]);
    expect(snapshot.databases).toHaveLength(5);
    const inspected=await inspectRecoveryFolder(snapshot.folder);
    expect(inspected.missing).toEqual([]);
    expect(inspected.databases.every(item=>item.sha256Verified)).toBe(true);

    // Mutating live data after snapshot may never silently change recovery.
    f.tasks.createTask({title:"Added after snapshot"});
    f.knowledge.importText({sourcePath:join(f.root,"later.md"),title:"Later",
      format:"markdown",text:"Post snapshot knowledge."});
    const restored=join(f.root,"restored");
    await recoverToNewProfile({folder:snapshot.folder,destination:restored,
      activeUserData:f.live,expectedFingerprint:inspected.fingerprint});
    const recoveredTasks=track(new LocalStore(join(restored,"study-anchor-tasks.sqlite")));
    const recoveredKb=track(new KnowledgeStore(join(restored,"study-anchor-knowledge.sqlite")));
    const recoveredMail=track(new CampusMailStore(join(restored,"study-anchor-mail.sqlite")));
    const recoveredCalendar=track(new FixedCalendarStore(join(restored,"study-anchor-calendar.sqlite")));
    const recoveredPlanning=track(new PlanningStore(join(restored,"study-anchor-planning.sqlite")));
    expect(recoveredTasks.listTasks()).toHaveLength(3);
    expect(recoveredTasks.listTasks().some(t=>t.id===own.id)).toBe(true);
    expect(recoveredTasks.listTasks().some(t=>t.title==="Added after snapshot")).toBe(false);
    expect(recoveredTasks.reviewMailCandidate(mailRecord,"accept").created).toBe(false);
    expect(recoveredKb.listDocuments()).toHaveLength(1);
    expect(recoveredKb.listCards()).toHaveLength(1);
    expect(recoveredKb.listCards()[0].reviewCount).toBe(1);
    expect(recoveredMail.list(ACCOUNT)).toHaveLength(1);
    expect(recoveredPlanning.listCommitted()).toHaveLength(1);
    expect(recoveredCalendar.list()).toHaveLength(1); // manual class
    expect(recoveredCalendar.listCanvasEvents(api.origin,91)).toHaveLength(1);
    expect(recoveredTasks.focusRewards()).toMatchObject({earned:25,spent:10,available:15});
    for(const sensitive of ["study-anchor-ai.enc","study-anchor-ai-usage.sqlite",
      "study-anchor-mail-drafts.enc","study-anchor-team-history.sqlite"]){
      expect(existsSync(join(restored,sensitive))).toBe(false);
    }
    expect(readFileSync(join(restored,"study-anchor-recovery.json"),"utf8"))
      .not.toContain("Private draft plaintext");
    expect(f.tasks.listTasks()).toHaveLength(4); // recovery never mutates live data
    canvas.cancel();
  },30_000);
});
