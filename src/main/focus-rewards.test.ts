import {afterEach,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LocalStore} from "./local-store";
import {backupBeforeMigration} from "./local-backup";
import {parseRewardCreate,parseRewardEdit,parseRewardRedeem,virtualFocusLevel}
  from "./focus-rewards";

const roots:string[]=[];
const opened:LocalStore[]=[];
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"sa-rewards-"));roots.push(root);
  const path=join(root,"study-anchor-tasks.sqlite");
  const store=new LocalStore(path);opened.push(store);
  return {root,path,store};
}
function close(store:LocalStore){
  const i=opened.indexOf(store);
  if(i>=0)opened.splice(i,1);
  store.close();
}
function earn(db:LocalStore,minutes:number){
  db.recordFocusSession({sessionId:randomUUID(),plannedMinutes:minutes,
    elapsedSeconds:minutes*60,title:"Synthetic test session"});
}
function reward(title:string,cost:number){
  return {title,description:"User-defined offline promise",cost};
}
afterEach(()=>{
  while(opened.length)opened.pop()!.close();
  while(roots.length)rmSync(roots.pop()!,{force:true,recursive:true});
});

describe("FOC-006 private virtual reward ledger",()=>{
  it("never spends unearned points and never modifies earned session totals",()=>{
    const {store}=fixture();
    earn(store,25);earn(store,15);
    const breakfast=store.createFocusReward(reward("Break time",30));
    expect(store.focusRewards()).toMatchObject({
      earned:40,spent:0,available:40,level:1,badge:"刚刚启航",
    });
    const receipt=store.redeemFocusReward({
      redemptionId:randomUUID(),rewardId:breakfast.id,
    });
    expect(receipt).toMatchObject({
      rewardId:breakfast.id,rewardTitle:"Break time",cost:30,
    });
    expect(store.focusRewards()).toMatchObject({earned:40,spent:30,available:10});
    expect(store.focusSummary().points).toBe(40);
    expect(()=>store.redeemFocusReward({
      redemptionId:randomUUID(),rewardId:breakfast.id,
    })).toThrow("Insufficient");
    expect(store.focusRewards().recentRedemptions).toEqual([receipt]);
  });

  it("idempotently replays a receipt even if price or active state changes",()=>{
    const {store}=fixture();earn(store,50);
    const first=store.createFocusReward(reward("A walk",20));
    const id=randomUUID();
    const receipt=store.redeemFocusReward({redemptionId:id,rewardId:first.id});
    const modified=store.editFocusReward({...reward("Longer walk",42),id:first.id,
      active:false,expectedUpdatedAt:first.updatedAt});
    expect(modified.updatedAt).not.toBe(first.updatedAt);
    expect(store.redeemFocusReward({redemptionId:id,rewardId:first.id})).toEqual(receipt);
    expect(store.focusRewards()).toMatchObject({earned:50,spent:20,available:30});
    const second=store.createFocusReward(reward("Another",5));
    expect(()=>store.redeemFocusReward({redemptionId:id,rewardId:second.id}))
      .toThrow("another reward");
    expect(()=>store.redeemFocusReward({redemptionId:randomUUID(),rewardId:first.id}))
      .toThrow("unavailable");
    expect(store.focusRewards().recentRedemptions[0].rewardTitle).toBe("A walk");
    expect(store.focusRewards().recentRedemptions[0].cost).toBe(20);
  });

  it("requires optimistic version checks on edits and preserves existing receipts",()=>{
    const {store}=fixture();earn(store,60);
    const original=store.createFocusReward(reward("Book",10));
    const receipt=store.redeemFocusReward({
      redemptionId:randomUUID(),rewardId:original.id,
    });
    const next=store.editFocusReward({id:original.id,title:"Notebook",description:"",
      cost:15,active:true,expectedUpdatedAt:original.updatedAt});
    expect(()=>store.editFocusReward({...reward("Wrong",1),id:original.id,
      active:true,expectedUpdatedAt:original.updatedAt})).toThrow("reload");
    expect(next.updatedAt).not.toBe(original.updatedAt);
    expect(store.focusRewards().recentRedemptions).toEqual([receipt]);
  });

  it("is serializable across two SQLite connections and survives restart",()=>{
    const {path,store}=fixture();earn(store,20);
    const item=store.createFocusReward(reward("A film",15));
    const other=new LocalStore(path);opened.push(other);
    const r1=store.redeemFocusReward({redemptionId:randomUUID(),rewardId:item.id});
    expect(()=>other.redeemFocusReward({
      redemptionId:randomUUID(),rewardId:item.id,
    })).toThrow("Insufficient");
    expect(other.focusRewards().available).toBe(5);
    close(other);close(store);
    const reopened=new LocalStore(path);opened.push(reopened);
    expect(reopened.focusRewards()).toMatchObject({earned:20,spent:15,available:5});
    expect(reopened.focusRewards().recentRedemptions).toEqual([r1]);
  });

  it("is strict about IDs, unknown fields, price, title and forged balances",()=>{
    const valid={title:"Reward",description:"",cost:1};
    for(const input of [{...valid,cost:0},{...valid,cost:1.5},
      {...valid,cost:1000001},{...valid,title:" "},
      {...valid,available:1000000},{...valid,description:"x".repeat(501)}]){
      expect(()=>parseRewardCreate(input)).toThrow();
    }
    const {store}=fixture();
    const x=store.createFocusReward(valid);
    expect(()=>parseRewardEdit({id:x.id,expectedUpdatedAt:x.updatedAt,
      ...valid,active:true,earned:100})).toThrow();
    expect(()=>parseRewardRedeem({rewardId:x.id,
      redemptionId:randomUUID(),cost:0})).toThrow();
    expect(()=>parseRewardRedeem({rewardId:"../../secret",redemptionId:randomUUID()})).toThrow();
    expect(()=>store.redeemFocusReward({
      rewardId:x.id,redemptionId:randomUUID(),
    })).toThrow("Insufficient");
    expect(store.focusRewards().spent).toBe(0);
  });

  it("uses earned (not available) points for cosmetic levels",()=>{
    expect(virtualFocusLevel(0).level).toBe(1);
    expect(virtualFocusLevel(100).level).toBe(2);
    expect(virtualFocusLevel(500).level).toBe(3);
    expect(virtualFocusLevel(1500).level).toBe(4);
    expect(()=>virtualFocusLevel(-1)).toThrow();
  });

  it("backups existing v10 database before v11 upgrade and retains earned points",async()=>{
    const {root,path,store}=fixture();
    earn(store,25);
    const total=store.focusSummary();
    close(store);
    const db=new DatabaseSync(path);
    db.exec("DROP TABLE focus_reward_redemptions; DROP TABLE focus_rewards; PRAGMA user_version=10");
    db.close();
    const backupFolder=await backupBeforeMigration(root,"study-anchor-tasks.sqlite",11);
    expect(backupFolder).not.toBeNull();
    const prior=new DatabaseSync(join(backupFolder!,"study-anchor-tasks.sqlite"),{readOnly:true});
    expect((prior.prepare("PRAGMA user_version").get() as {user_version:number}).user_version)
      .toBe(10);
    prior.close();
    const migrated=new LocalStore(path);opened.push(migrated);
    expect(migrated.focusSummary()).toEqual(total);
    expect(migrated.focusRewards()).toMatchObject({earned:25,spent:0,available:25});
    const v11=new DatabaseSync(path,{readOnly:true});
    expect((v11.prepare("PRAGMA user_version").get() as {user_version:number}).user_version)
      .toBe(11);
    v11.close();
  });

  it("does not silently drop ledger history while showing only 100 recent receipts",()=>{
    const {store}=fixture();earn(store,100);
    const item=store.createFocusReward(reward("Virtual sticker",1));
    for(let i=0;i<102;i++){
      store.redeemFocusReward({redemptionId:randomUUID(),rewardId:item.id});
      if(i===99)earn(store,10);
    }
    expect(store.focusRewards()).toMatchObject({earned:110,spent:102,available:8});
    expect(store.focusRewards().recentRedemptions).toHaveLength(100);
  });
});
