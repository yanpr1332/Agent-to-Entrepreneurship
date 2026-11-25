import {describe,expect,it} from "vitest";
import {
  parsePersonalFileList,parsePersonalFilePayload,parsePersonalFileResult,
  requirePersonalFileName,requireFileSize,
} from "./personal-file-sync";

const id="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const hash="2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const remote={
  fileId:id,filename:"hello.txt",sha256:hash,byteLength:5,
  version:1,updatedAt:"2026-11-25T01:02:03.000Z",
};
describe("V0.2 consented personal file wire contract",()=>{
  it("accepts only bounded, safe user-selected file names and small bytes",()=>{
    for(const name of ["../a.txt","a/b.txt","a\\b.txt","evil.exe",
      "\u0000foo.md","../.md","a","foo.md\nother","CON.txt","unsafe:name.md"]){
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
    const payload={...remote,base64:"aGVsbG8="};
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

