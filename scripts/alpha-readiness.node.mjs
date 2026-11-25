import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ALPHA_CASES, blankReport, checkAlphaEvidence } from "./alpha-readiness.mjs";

const SHA="a".repeat(40);
const HASH="c".repeat(64);
function complete(){
  const report=blankReport(SHA);
  report.ci.windowsRunId=125;
  report.ci.macosRunId=125;
  report.issues.blocker=0;
  report.issues.critical=0;
  for(const [id,mode] of ALPHA_CASES){
    report.cases[id]={status:"pass",mode,reviewer:"R01",
      observedAt:"2026-11-25T12:00:00.000Z",evidenceSha256:HASH};
  }
  return report;
}
test("every original ALPHA-01..20 is mandatory, none pass in default template",()=>{
  const report=blankReport(SHA);
  assert.deepEqual(ALPHA_CASES.map(x=>x[0]),
    Array.from({length:20},(_,i)=>"ALPHA-"+String(i+1).padStart(2,"0")));
  const result=checkAlphaEvidence(report,SHA);
  assert.equal(result.readyForHumanReview,false);
  assert.equal(result.passed,0);
  assert.equal(result.blocked,20);
  assert.ok(result.blockers.some(x=>x.includes("CI not attested")));
});
test("complete human-supplied inventory is marked for independent review, not certified",()=>{
  assert.deepEqual(checkAlphaEvidence(complete(),SHA),{
    readyForHumanReview:true,passed:20,failed:0,blocked:0,total:20,blockers:[],
  });
});
test("CI green alone never makes an untested Alpha ready",()=>{
  const report=blankReport(SHA);
  report.ci.windowsRunId=123;
  report.ci.macosRunId=123;
  report.issues.blocker=0;
  report.issues.critical=0;
  const result=checkAlphaEvidence(report,SHA);
  assert.equal(result.readyForHumanReview,false);
  assert.equal(result.blocked,20);
});
test("rejects mismatched commit, wrong platform, omitted/extra or fake acceptance entries",()=>{
  const report=complete();
  assert.throws(()=>checkAlphaEvidence(report,"b".repeat(40)),/differs/);
  delete report.cases["ALPHA-10"];
  assert.throws(()=>checkAlphaEvidence(report,SHA),/20 exact/);
  report.cases["ALPHA-10"]={status:"pass",mode:"team-five-live",
    reviewer:"R01",observedAt:"2026-11-25T12:00:00.000Z",evidenceSha256:HASH};
  report.cases["ALPHA-02"].mode="win";
  assert.throws(()=>checkAlphaEvidence(report,SHA),/mode/);
  report.cases["ALPHA-02"].mode="macos-install";
  report.cases["ALPHA-11"].evidenceSha256="invalid";
  assert.throws(()=>checkAlphaEvidence(report,SHA),/evidence SHA/);
});
test("rejects unsupported fields and leaks in opaque failure reasons",()=>{
  const report=complete();
  report.cases["ALPHA-06"]={status:"blocked",mode:"canvas-token",
    reason:"I posted my key to https://untrusted.invalid"};
  assert.throws(()=>checkAlphaEvidence(report,SHA),/reason/);
  report.cases["ALPHA-06"]={status:"blocked",mode:"canvas-token",reason:"No real account"};
  report.cases["ALPHA-08"].password="must-not-export";
  assert.throws(()=>checkAlphaEvidence(report,SHA),/fields/);
  delete report.cases["ALPHA-08"].password;
  report.issues.blocker=1;
  const result=checkAlphaEvidence(report,SHA);
  assert.equal(result.readyForHumanReview,false);
  assert.equal(result.blocked,1);
  assert.ok(result.blockers.some(x=>x.includes("Open blocker issues")));
});
test("manual template CLI uses create-only and check is fail-closed with exit 1",()=>{
  const root=mkdtempSync(join(tmpdir(),"sa-gate-"));
  const report=join(root,"evidence.json");
  try{
    const args=["scripts/alpha-readiness.mjs","init",report,SHA];
    const created=spawnSync(process.execPath,args,{encoding:"utf8"});
    assert.equal(created.status,0,created.stderr);
    assert.ok(existsSync(report));
    const first=readFileSync(report,"utf8");
    assert.doesNotMatch(first,/"status": "pass"/);
    const repeated=spawnSync(process.execPath,args,{encoding:"utf8"});
    assert.equal(repeated.status,1);
    assert.equal(readFileSync(report,"utf8"),first);
    const checked=spawnSync(process.execPath,["scripts/alpha-readiness.mjs",
      "check",report,SHA],{encoding:"utf8"});
    assert.equal(checked.status,1);
    assert.match(checked.stdout,/0\/20 pass/);
    assert.match(checked.stdout,/ALPHA-10: blocked/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
