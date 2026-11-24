import {describe,expect,it} from "vitest";
import {createTeamHistoryCipher} from "./workspace-history-crypto";
import {testHistoryCipher} from "./workspace-history-crypto.test-helper";

describe("ALPHA-SYNC-003D OS-backed history encryption boundary",()=>{
  it("refuses local persistence when the OS cannot protect ciphertext",()=>{
    expect(()=>createTeamHistoryCipher({
      isEncryptionAvailable:()=>false,
      encryptString:()=>Buffer.from("wrong"),
      decryptString:()=>"",
    })).toThrow("OS encryption");
  });

  it("rejects Electron insecure basic_text backend even if availability is true",()=>{
    expect(()=>createTeamHistoryCipher({
      isEncryptionAvailable:()=>true,
      getSelectedStorageBackend:()=>"basic_text",
      encryptString:()=>Buffer.from("plaintext"),
      decryptString:()=>"",
    })).toThrow("OS encryption");
  });

  it("protects record payloads with non-deterministic authenticated bytes",()=>{
    const raw=JSON.stringify({body:"Sensitive team discussion",title:"Private title"});
    const one=testHistoryCipher.encrypt(raw),two=testHistoryCipher.encrypt(raw);
    expect(one).not.toBe(two);
    expect(one).toMatch(/^sa1:/);
    expect(one).not.toContain("Sensitive team discussion");
    expect(testHistoryCipher.decrypt(one)).toBe(raw);
    expect(testHistoryCipher.decrypt(two)).toBe(raw);
  });

  it("refuses old plaintext, unknown versions, malformed base64 and tampering",()=>{
    for(const value of ['{"body":"plain"}',"sa0:aGVsbG8=","sa1:%%%","sa1:YWJj\n",
      "sa1:YQ==A","sa1:","sa1:YWJj"]){
      expect(()=>testHistoryCipher.decrypt(value)).toThrow();
    }
    const original=testHistoryCipher.encrypt("private");
    const bytes=Buffer.from(original.slice(4),"base64");
    bytes[13]^=1;
    expect(()=>testHistoryCipher.decrypt("sa1:"+bytes.toString("base64"))).toThrow();
  });

  it("does not accept an empty or broken OS ciphertext",()=>{
    const broken=createTeamHistoryCipher({
      isEncryptionAvailable:()=>true,
      encryptString:()=>Buffer.alloc(0),
      decryptString:()=>"",
    });
    expect(()=>broken.encrypt("message")).toThrow("no protected bytes");
  });
});
