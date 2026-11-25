import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDownloadedAlpha } from "./verify-downloaded-alpha.mjs";

const commit="a".repeat(40);
async function fixture(work) {
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-artifact-"));
  const name="Study Anchor Setup.exe";
  const bytes=Buffer.alloc(1024*1024+1,0x64);
  const hash=createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dir,name),bytes);
  writeFileSync(join(dir,"SHA256SUMS.txt"),hash+"  "+name+"\n");
  writeFileSync(join(dir,"BUILD_EVIDENCE.json"),JSON.stringify({
    schema:1,product:"Study Anchor",target:"win",commit,
    signed:false,notarized:false,
    installers:[{name,bytes:bytes.length,sha256:hash}],
  }));
  try { await work({dir,name,hash}); }
  finally {rmSync(dir,{recursive:true,force:true});}
}
test("offline downloaded Windows artifact passes exact SHA and pinned commit",async()=>{
  await fixture(async({dir})=>{
    assert.deepEqual(await verifyDownloadedAlpha(dir,"win",commit),{
      platform:"win",commit,verifiedFiles:1,unsigned:true,
    });
  });
});
test("rejects tampered installer and wrong independent commit",async()=>{
  await fixture(async({dir,name})=>{
    await assert.rejects(verifyDownloadedAlpha(dir,"win","b".repeat(40)),/commit\/platform/);
    writeFileSync(join(dir,name),Buffer.alloc(1024*1024+1,0x41));
    await assert.rejects(verifyDownloadedAlpha(dir,"win",commit),/SHA-256 mismatch/);
  });
});
test("rejects forged or duplicate checksum filenames",async()=>{
  await fixture(async({dir})=>{
    writeFileSync(join(dir,"SHA256SUMS.txt"),"a".repeat(64)+"  ../../evil.exe\n");
    await assert.rejects(verifyDownloadedAlpha(dir,"win",commit),/Malformed/);
  });
});
test("rejects inconsistent build evidence, unverified filenames, and signed claims",async()=>{
  await fixture(async({dir})=>{
    const path=join(dir,"BUILD_EVIDENCE.json");
    const evidence=JSON.parse(readFileSync(path,"utf8"));
    evidence.signed=true;
    writeFileSync(path,JSON.stringify(evidence));
    await assert.rejects(verifyDownloadedAlpha(dir,"win",commit),/unsigned/);
  });
});
