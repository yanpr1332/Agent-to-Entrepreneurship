import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";
import type { MailRecord } from "../shared/mail-model";

const account="student@sjtu.edu.cn";
const mail:MailRecord={
  account,uidValidity:91,uid:8,from:"Teacher <teacher@sjtu.edu.cn>",
  subject:"第六周实验报告",date:"2026-11-10T00:00:00Z",
  messageId:"<mail-8@sjtu.edu.cn>",receivedAt:"2026-11-10T00:01:00Z",
};
const stores:LocalStore[]=[];
function memory():LocalStore{
  const db=new LocalStore(":memory:");stores.push(db);return db;
}
afterEach(()=>{while(stores.length)stores.pop()!.close();});

describe("mail candidate reviews in canonical local task database",()=>{
  it("creates a single local task, never treats sent-at as due-at",()=>{
    const db=memory();
    const first=db.reviewMailCandidate(mail,"accept");
    const again=db.reviewMailCandidate(mail,"accept");
    expect(first.created).toBe(true);
    expect(again).toEqual({action:"accept",taskId:first.taskId,created:false});
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listTasks()[0]).toMatchObject({
      title:"第六周实验报告",description:"",dueDate:null,priority:"normal",
      completed:false,source:null,
    });
    expect(db.mailCandidateDecisions(account)).toEqual([{
      uidValidity:91,uid:8,decision:"accepted",taskId:first.taskId,
    }]);
  });

  it("ignores, resumes and protects review decisions across repeated calls",()=>{
    const db=memory();
    db.reviewMailCandidate(mail,"ignore");
    db.reviewMailCandidate(mail,"ignore");
    expect(db.mailCandidateDecisions(account)).toHaveLength(1);
    expect(()=>db.reviewMailCandidate(mail,"accept")).toThrow("Restore");
    db.reviewMailCandidate(mail,"reopen");
    expect(db.mailCandidateDecisions(account)).toEqual([]);
    expect(db.reviewMailCandidate(mail,"accept").created).toBe(true);
    expect(()=>db.reviewMailCandidate(mail,"ignore")).toThrow();
  });

  it("keeps account and UIDVALIDITY separate, even if the numeric UID repeats",()=>{
    const db=memory();
    db.reviewMailCandidate(mail,"ignore");
    const otherValidity={...mail,uidValidity:92};
    const otherAccount={...mail,account:"another@sjtu.edu.cn"};
    expect(db.reviewMailCandidate(otherValidity,"accept").created).toBe(true);
    expect(db.reviewMailCandidate(otherAccount,"accept").created).toBe(true);
    expect(db.mailCandidateDecisions(account)).toHaveLength(2);
    expect(db.mailCandidateDecisions("another@sjtu.edu.cn")).toHaveLength(1);
    expect(db.listTasks()).toHaveLength(2);
  });

  it("keeps accepted review as a tombstone even when user deletes the local task",()=>{
    const db=memory();
    const first=db.reviewMailCandidate(mail,"accept");
    expect(db.removeTask(first.taskId!)).toBe(true);
    expect(db.listTasks()).toHaveLength(0);
    const repeat=db.reviewMailCandidate(mail,"accept");
    expect(repeat).toEqual({action:"accept",taskId:first.taskId,created:false});
    expect(db.listTasks()).toHaveLength(0);
  });

  it("removes mailbox decisions on disconnect without removing personal tasks",()=>{
    const db=memory();
    db.reviewMailCandidate(mail,"ignore");
    db.reviewMailCandidate({...mail,uid:9},"accept");
    expect(db.clearMailCandidateDecisions(account)).toBe(2);
    expect(db.listTasks()).toHaveLength(1);
    expect(db.mailCandidateDecisions(account)).toEqual([]);
  });

  it("rejects forged non-SJTU identity and invalid UID before writing",()=>{
    const db=memory();
    expect(()=>db.reviewMailCandidate({...mail,account:"fake@example.net"},"accept")).toThrow();
    expect(()=>db.reviewMailCandidate({...mail,uid:0},"ignore")).toThrow();
    expect(db.listTasks()).toHaveLength(0);
    expect(db.mailCandidateDecisions(account)).toHaveLength(0);
  });

  it("persisted review state survives restarting a v4 database",()=>{
    const directory=mkdtempSync(join(tmpdir(),"ate-mail-candidate-"));
    const file=join(directory,"tasks.sqlite");
    try{
      const first=new LocalStore(file);
      const result=first.reviewMailCandidate(mail,"accept");
      first.close();
      const second=new LocalStore(file);
      expect(second.reviewMailCandidate(mail,"accept"))
        .toEqual({action:"accept",taskId:result.taskId,created:false});
      expect(second.listTasks()).toHaveLength(1);
      second.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  it("upgrades an existing v3 database without discarding old tasks or Canvas links",()=>{
    const directory=mkdtempSync(join(tmpdir(),"ate-v3-mail-"));
    const file=join(directory,"tasks.sqlite");
    try{
      const first=new LocalStore(file);
      const original=first.createTask({title:"Existing focus task",description:"Keep me"});
      first.close();
      // Simulate a pre-upgrade v3 file; all earlier tables and data remain intact.
      const raw=new DatabaseSync(file);
      raw.exec("DROP TABLE mail_candidate_reviews; PRAGMA user_version = 3");
      raw.close();
      const upgraded=new LocalStore(file);
      expect(upgraded.listTasks()).toMatchObject([{
        id:original.id,title:"Existing focus task",description:"Keep me",
      }]);
      expect(upgraded.reviewMailCandidate(mail,"ignore").action).toBe("ignore");
      upgraded.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
