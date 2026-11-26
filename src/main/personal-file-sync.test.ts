import {afterEach,describe,expect,it,vi} from "vitest";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PersonalFileSyncService} from "./personal-file-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";
import type {RemotePersonalFile,PersonalFilePayload,PersonalFileApplyResult}
  from "../shared/personal-file-sync";

const A="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const B="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const dirs:string[]=[];
const stores:PersonalFileSyncService[]=[];
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
afterEach(()=>{
  while(stores.length){try{stores.pop()!.close();}catch{/* already closed */}}
  while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});
});

function fake(){
  let owner=A;
  let offline=false;
  const rows=new Map<string,{item:RemotePersonalFile;bytes:Buffer}>();
  const cloud={
    currentUserId:vi.fn(()=>owner),
    listPersonalFiles:vi.fn(async()=>{
      if(offline)throw Error("Network offline");
      return [...rows.entries()].filter(([key])=>key.startsWith(owner+":")).map(([,v])=>v.item);
    }),
    applyPersonalFile:vi.fn(async(input:{
      fileId:string;baseVersion:number;filename:string;sha256:string;
      byteLength:number;base64:string;
    }):Promise<PersonalFileApplyResult>=>{
      if(offline)throw Error("Network offline");
      const key=owner+":"+input.fileId;
      const current=rows.get(key),bytes=Buffer.from(input.base64,"base64");
      if(hash(bytes)!==input.sha256||bytes.length!==input.byteLength)
        throw Error("Checksum mismatch");
      if(current?.item.sha256===input.sha256&&current.item.filename===input.filename)
        return {status:"duplicate",version:current.item.version};
      if((current?.item.version??0)!==input.baseVersion)
        return {status:"conflict",version:current?.item.version??null};
      const version=(current?.item.version??0)+1;
      rows.set(key,{bytes,item:{
        fileId:input.fileId,filename:input.filename,sha256:input.sha256,
        byteLength:input.byteLength,version,updatedAt:"2026-11-25T00:00:00.000Z",
      }});
      return {status:"accepted",version};
    }),
    readPersonalFile:vi.fn(async(id:string):Promise<PersonalFilePayload>=>{
      if(offline)throw Error("Network offline");
      const current=rows.get(owner+":"+id);
      if(!current)throw Error("Not found");
      return {...current.item,base64:current.bytes.toString("base64")};
    }),
    deletePersonalFile:vi.fn(async(id:string,version:number):Promise<PersonalFileApplyResult>=>{
      if(offline)throw Error("Network offline");
      const key=owner+":"+id,current=rows.get(key);
      if(!current||current.item.version!==version)
        return {status:"conflict",version:current?.item.version??null};
      rows.delete(key);
      return {status:"accepted",version:version+1};
    }),
  };
  return {cloud,rows,asUser:(id:string)=>{owner=id;},
    setOffline:(v:boolean)=>{offline=v;}};
}
function root(){
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-file-"));
  dirs.push(dir);return dir;
}
function service(cloud:ReturnType<typeof fake>["cloud"],dir:string){
  const instance=new PersonalFileSyncService(cloud as unknown as SharedCloudClient,dir);
  stores.push(instance);return instance;
}
function source(dir:string,name:string,body:string){
  const path=join(dir,name);
  writeFileSync(path,body);return path;
}

describe("V02-SYNC-02: opt-in durable small-file cross-device transfer",()=>{
  it("never uploads before the separate confirmation; persists staged bytes after restart",async()=>{
    const remote=fake(),dir=root(),path=source(dir,"sample.md","# Offline personal notes");
    let a=service(remote.cloud,dir);
    const staged=await a.stagePickedFile(path);
    expect(remote.cloud.applyPersonalFile).not.toHaveBeenCalled();
    expect(a.pending()).toMatchObject([{fileId:staged.fileId,baseVersion:0}]);
    a.close();stores.splice(stores.indexOf(a),1);
    a=service(remote.cloud,dir);
    expect(a.pending()).toHaveLength(1);
    remote.setOffline(true);
    await expect(a.upload(staged.fileId)).rejects.toThrow("Network offline");
    expect(a.pending()).toHaveLength(1);
    remote.setOffline(false);
    expect(await a.upload(staged.fileId)).toMatchObject({status:"uploaded",version:1});
    expect(a.pending()).toHaveLength(0);
    expect(remote.rows.size).toBe(1);
    const b=service(remote.cloud,root());
    expect((await b.overview()).remote).toHaveLength(1);
    const saved=await b.download(staged.fileId,1);
    expect(readFileSync(saved.path,"utf8")).toBe("# Offline personal notes");
    expect(await b.download(staged.fileId,1)).toEqual(saved);
  });

  it("never overwrites divergent local downloads or stale remote versions",async()=>{
    const remote=fake(),dir=root();
    const a=service(remote.cloud,dir);
    const staged=await a.stagePickedFile(source(dir,"one.txt","version-one"));
    await a.upload(staged.fileId);
    const b=service(remote.cloud,root());
    const old=await b.stagePickedFile(source(dir,"two.txt","local-change"),{
      fileId:staged.fileId,version:1,
    });
    // Another device wins v2 while this replacement is only staged locally.
    const updated=await a.stagePickedFile(source(dir,"three.txt","remote-version-two"),{
      fileId:staged.fileId,version:1,
    });
    expect(await a.upload(updated.fileId)).toEqual({status:"uploaded",version:2});
    expect(await b.upload(old.fileId)).toEqual({status:"conflict",version:2});
    expect(b.pending()).toHaveLength(1);
    const fresh=await b.download(staged.fileId,2);
    expect(readFileSync(fresh.path,"utf8")).toBe("remote-version-two");
    writeFileSync(fresh.path,"unrelated local changes");
    await expect(b.download(staged.fileId,2)).rejects.toThrow("refusing to overwrite");
    expect(readFileSync(fresh.path,"utf8")).toBe("unrelated local changes");
  });

  it("refuses a modified staged byte snapshot, invalid file, unsupported extension and oversized input",async()=>{
    const remote=fake(),dir=root(),a=service(remote.cloud,dir);
    await expect(a.stagePickedFile(source(dir,"script.exe","malicious"))).rejects.toThrow("Only bounded");
    await expect(a.stagePickedFile(source(dir,"blank.txt",""))).rejects.toThrow("between 1 byte");
    const huge=join(dir,"oversized.pdf");
    writeFileSync(huge,Buffer.alloc(1_048_577));
    await expect(a.stagePickedFile(huge)).rejects.toThrow("between 1 byte");
    const staged=await a.stagePickedFile(source(dir,"safe.txt","original"));
    const internal=join(dir,"study-anchor-file-staging",A,staged.fileId+".bin");
    writeFileSync(internal,"tampered");
    await expect(a.upload(staged.fileId)).rejects.toThrow("checksum changed");
    expect(remote.cloud.applyPersonalFile).not.toHaveBeenCalled();
    expect(a.pending()).toHaveLength(1);
  });

  it("can stage new or replacement bytes offline, but cannot upload until network resumes",async()=>{
    const remote=fake(),dir=root(),a=service(remote.cloud,dir);
    remote.setOffline(true);
    const first=await a.stagePickedFile(source(dir,"offline.md","# Offline work"));
    const status=await a.overview();
    expect(status).toMatchObject({cloudAvailable:false,pending:[{fileId:first.fileId}]});
    expect(status.remote).toEqual([]); // unknown, not proof of no remote records
    await expect(a.upload(first.fileId)).rejects.toThrow("Network offline");
    expect(a.pending()).toHaveLength(1);
    remote.setOffline(false);
    expect(await a.upload(first.fileId)).toEqual({status:"uploaded",version:1});
    remote.setOffline(true);
    const replacement=await a.stagePickedFile(source(dir,"offline2.md","# Followup"),{
      fileId:first.fileId,version:1,
    });
    expect(replacement.baseVersion).toBe(1);
    remote.setOffline(false);
    expect(await a.upload(first.fileId)).toEqual({status:"uploaded",version:2});
  });

  it("isolates staged owner accounts and keeps local stop different from remote deletion",async()=>{
    const remote=fake(),dir=root(),a=service(remote.cloud,dir);
    const staged=await a.stagePickedFile(source(dir,"notes.txt","private-A"));
    remote.asUser(B);
    expect(a.pending()).toEqual([]);
    await expect(a.upload(staged.fileId)).rejects.toThrow("Staged file");
    remote.asUser(A);
    expect(a.stopLocal(staged.fileId)).toEqual({stopped:true});
    expect(remote.cloud.deletePersonalFile).not.toHaveBeenCalled();
    const newStaged=await a.stagePickedFile(source(dir,"notes.txt","private-A"));
    await a.upload(newStaged.fileId);
    expect((await a.overview()).remote).toHaveLength(1);
    const oldVersion=1;
    expect(await a.deleteRemote(newStaged.fileId,oldVersion))
      .toMatchObject({status:"deleted",version:2});
    expect((await a.overview()).remote).toHaveLength(0);
    expect(remote.cloud.deletePersonalFile).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an account switch during staging and retains no pending record",async()=>{
    const remote=fake(),dir=root(),a=service(remote.cloud,dir);
    remote.cloud.listPersonalFiles.mockImplementationOnce(async()=>{
      remote.asUser(B);return [];
    });
    await expect(a.stagePickedFile(source(dir,"note.md","hello"))).rejects.toThrow("Account changed");
    expect(a.pending()).toEqual([]);
    remote.asUser(A);
    expect(a.pending()).toEqual([]);
  });

  it("rejects corrupted remote content before creating a downloaded file",async()=>{
    const remote=fake(),dir=root(),a=service(remote.cloud,dir);
    const staged=await a.stagePickedFile(source(dir,"notes.md","clean"));
    await a.upload(staged.fileId);
    remote.cloud.readPersonalFile.mockResolvedValueOnce({
      fileId:staged.fileId,filename:"notes.md",version:1,
      sha256:staged.sha256,byteLength:5,base64:Buffer.from("wrong").toString("base64"),
    });
    await expect(a.download(staged.fileId,1)).rejects.toThrow("checksum mismatch");
  });
});