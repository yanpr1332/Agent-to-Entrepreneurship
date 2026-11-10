import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampusMailStore } from "./mail-store";

const account="student@sjtu.edu.cn";
const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});

describe("local mail metadata SQLite",()=>{
  it("deduplicates and persists only header data across restarts",()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-mail-test-"));
    directories.push(dir);
    const path=join(dir,"mail.sqlite");
    const db=new CampusMailStore(path);
    const header={uid:7,uidValidity:42,from:"Teacher",subject:"Exam",date:null,messageId:null};
    db.merge(account,42,[header]);
    db.merge(account,42,[header]);
    expect(db.list(account)).toHaveLength(1);
    db.close();
    const reopened=new CampusMailStore(path);
    expect(reopened.list(account)[0]).toMatchObject({account,uid:7,subject:"Exam"});
    reopened.clear(account);
    expect(reopened.list(account)).toHaveLength(0);
    reopened.close();
  });

  it("drops stale UID references if IMAP UIDVALIDITY changes (including empty inbox)",()=>{
    const db=new CampusMailStore(":memory:");
    db.merge(account,2,[{uid:1,uidValidity:2,from:"A",subject:"Old",date:null,messageId:null}]);
    db.merge(account,3,[]);
    expect(db.list(account)).toEqual([]);
    db.close();
  });

  it("keeps independent accounts isolated",()=>{
    const db=new CampusMailStore(":memory:");
    const hdr={uid:5,uidValidity:3,from:"A",subject:"One",date:null,messageId:null};
    db.merge(account,3,[hdr]);
    db.merge("second@sjtu.edu.cn",3,[{...hdr,subject:"Two"}]);
    expect(db.list(account)[0].subject).toBe("One");
    db.clear(account);
    expect(db.list("second@sjtu.edu.cn")).toHaveLength(1);
    db.close();
  });
});
