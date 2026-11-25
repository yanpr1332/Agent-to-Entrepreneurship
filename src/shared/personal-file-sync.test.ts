import {describe,expect,it} from "vitest";
import {createHash,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {
  parsePersonalFileList,parsePersonalFilePayload,parsePersonalFileResult,
  requirePersonalFileName,requireFileSize,
} from "./personal-file-sync";

const id=randomUUID();
const hash=createHash("sha256").update("hello").digest("hex");
const remote={
  fileId:id,filename:"hello.txt",sha256:hash,byteLength:5,
  version:1,updatedAt:"2026-11-25T01:02:03.000Z",
};
describe("V0.2 consented personal file wire contract",()=>{
  it("accepts only bounded, safe user-selected file names and small bytes",()=>{
    for(const name of ["../a.txt","a/b.txt","a\\b.txt","evil.exe",
      "\u0000foo.md","../.md","a","foo.md\nother"]){
      expect(()=>requirePersonalFileName(name)).toThrow();
    }
    expect(requirePersonalFileName("合成学习记录.pdf")).toBe("合成学习记录.pdf");
    expect(()=>requireFileSize(0)).toThrow();
    expect(()=>requireFileSize(1_048_577)).toThrow();
  });
  it("rejects injected, duplicated or malformed file manifest entries",()=>{
    expect(parsePersonalFileList([remote])).toEqual([remote]);
    expect(()=>parsePersonalFileList([remote,remote])).toThrow("Duplicate");
    expect(()=>parsePersonalFileList([{...remote,ownerId:"private"}])).toThrow();
    expect(()=>parsePersonalFileList([{...remote,sha256:"0"}])).toThrow();
    expect(()=>parsePersonalFileList([{...remote,version:0}])).toThrow();
    expect(()=>parsePersonalFileList([{...remote,filename:"a/../../b.txt"}])).toThrow();
    expect(()=>parsePersonalFileList(Array(21).fill(remote))).toThrow();
  });
  it("allows only exact canonical base64 and checksum metadata in download payload",()=>{
    const payload={...remote,base64:Buffer.from("hello").toString("base64")};
    delete (payload as Partial<typeof remote>).updatedAt;
    expect(parsePersonalFilePayload(payload)).toMatchObject({fileId:id,sha256:hash});
    expect(()=>parsePersonalFilePayload({...payload,base64:"YWJj\n"})).toThrow();
    expect(()=>parsePersonalFilePayload({...payload,base64:"!!!"})).toThrow();
    expect(()=>parsePersonalFilePayload({...payload,sourcePath:"private"})).toThrow();
  });
  it("rejects unknown commit results instead of treating them as successful",()=>{
    expect(parsePersonalFileResult({status:"accepted",version:1}))
      .toEqual({status:"accepted",version:1});
    expect(parsePersonalFileResult({status:"conflict",version:null}))
      .toEqual({status:"conflict",version:null});
    expect(()=>parsePersonalFileResult({status:"accepted",version:null})).toThrow();
    expect(()=>parsePersonalFileResult({status:"success",version:1})).toThrow();
    expect(()=>parsePersonalFileResult({status:"accepted",version:1,token:"private"})).toThrow();
  });
});

const sql=readFileSync(join(process.cwd(),
  "supabase/migrations/20261125_ate_personal_file_sync.sql"),"utf8");
describe("V02 file RPC SQL static security baseline (not real RLS attestation)",()=>{
  it("has RLS enabled and denies direct client access to raw content table",()=>{
    expect(sql).toContain("alter table public.ate_personal_files enable row level security;");
    expect(sql).toContain("revoke all on public.ate_personal_files from public,anon,authenticated;");
    expect(sql).not.toMatch(/grant\s+(?:select|insert|update|delete|all)\s+on\s+public\.ate_personal_files\s+to\s+(?:public|anon|authenticated)/i);
    for(const name of ["ate_file_list","ate_file_get","ate_file_apply"])
      expect(sql).toContain("public."+name);
    expect(sql.match(/security definer set search_path = ''/g)).toHaveLength(3);
    expect(sql).toContain("auth.uid()");
  });
  it("requires atomic CAS locks, caps size/count and verifies server-side digest",()=>{
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("for update");
    expect(sql).toContain("v_row.version<>p_base_version");
    expect(sql).toContain("digest(v_bytes,'sha256')");
    expect(sql).toContain("p_byte_length>1048576");
    expect(sql).toContain(")>=20");
  });
  it("deletes bytes atomically and never grants anonymous RPC execution",()=>{
    expect(sql).toContain("deleted=true,content=null,sha256=null");
    expect(sql).toContain("byte_length=0,version=version+1");
    expect(sql).toContain("grant execute on function public.ate_file_get(uuid) to authenticated");
    expect(sql).toContain("from public,anon,authenticated;");
  });
});
