#!/usr/bin/env node
/**
 * Offline/manual V0.1 acceptance evidence inventory. This is a strict
 * COMPLETENESS gate, not attestation or proof that anyone actually tested a
 * live service. It intentionally does not read evidence files, contact APIs,
 * handle credentials, install apps or self-mark any case as passed.
 *
 * A green GitHub CI run is only a code gate; the twenty manual Alpha checks
 * are separate and initially BLOCKED. This tool must never run as part of CI
 * with automatically populated "pass" records.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALPHA_CASES = Object.freeze([
  ["ALPHA-01","windows-install","Windows GUI install, launch and restart"],
  ["ALPHA-02","macos-install","macOS GUI install, launch and restart"],
  ["ALPHA-03","both-gui","Eight real module navigation flows on both OSes"],
  ["ALPHA-04","local-restart","Personal tasks editing, completion and restart"],
  ["ALPHA-05","canvas-live","Authorized real Canvas courses and assignments"],
  ["ALPHA-06","canvas-token","Canvas token privacy and per-account isolation"],
  ["ALPHA-07","imap-live","Authorized SJTU IMAP inbox and body consent"],
  ["ALPHA-08","smtp-live","User-confirmed real SMTP delivery"],
  ["ALPHA-09","mail-task-live","Real mail candidate accepted into calendar"],
  ["ALPHA-10","team-five-live","Five unique accounts and cross-device shared work"],
  ["ALPHA-11","team-rls-live","Real RLS, revoked member and stale JWT negative tests"],
  ["ALPHA-12","knowledge-samples","PDF, Markdown and TXT source search"],
  ["ALPHA-13","knowledge-graph","Cited cross-document graph associations"],
  ["ALPHA-14","review-persist","Review ratings and next-date persistence"],
  ["ALPHA-15","focus-rewards","Focus history and reward ledger without duplication"],
  ["ALPHA-16","ai-provider-live","Personally approved paid AI provider request"],
  ["ALPHA-17","restore-live","Five-DB isolated restore and GUI restart"],
  ["ALPHA-18","secret-audit","Credentials absent from log, backups and plain DB"],
  ["ALPHA-19","workbench-live","Real workbench data and persisted layout"],
  ["ALPHA-20","internal-release","Signed-off install instructions, demo and risks"],
]);
const SHA=/^[a-f0-9]{40}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const allowedStatus=new Set(["pass","fail","blocked"]);
function cleanReason(value) {
  return typeof value==="string" && value.length>=1 && value.length<=160 &&
    !/[\r\n\x00-\x1f\x7f]/.test(value) && !/https?:\/\/|@|(?:sk-|sb_secret_)/i.test(value);
}
function exactKeys(object,expected,label) {
  if(!object || typeof object!=="object" || Array.isArray(object) ||
    Object.keys(object).sort().join("|")!==[...expected].sort().join("|"))
    throw Error("Invalid "+label+" fields");
}
function fullCommit(raw) {
  if(typeof raw!=="string"||!SHA.test(raw))
    throw Error("Expected exact 40-character Git commit SHA");
  return raw.toLowerCase();
}
export function blankReport(commit) {
  const sha=fullCommit(commit);
  return {
    schema:1,product:"Study Anchor",commit:sha,
    ci:{windowsRunId:null,macosRunId:null},
    issues:{blocker:null,critical:null},
    cases:Object.fromEntries(ALPHA_CASES.map(([id,mode])=>
      [id,{status:"blocked",mode,reason:"Not independently accepted"}])),
  };
}
export function checkAlphaEvidence(raw,expectedCommit) {
  const sha=fullCommit(expectedCommit);
  exactKeys(raw,["schema","product","commit","ci","issues","cases"],"report");
  if(raw.schema!==1 || raw.product!=="Study Anchor"||raw.commit!==sha)
    throw Error("Report commit/product differs from the requested release");
  exactKeys(raw.ci,["windowsRunId","macosRunId"],"CI summary");
  exactKeys(raw.issues,["blocker","critical"],"open critical issues");
  const blockers=[];
  for(const key of ["windowsRunId","macosRunId"]){
    const id=raw.ci[key];
    if(id===null)blockers.push("CI not attested: "+key);
    else if(!Number.isSafeInteger(id)||id<=0)
      throw Error("Invalid CI run identifier for "+key);
  }
  for(const key of ["blocker","critical"]){
    const count=raw.issues[key];
    if(count===null) blockers.push("Unreviewed open-issue count: "+key);
    else if(!Number.isSafeInteger(count)||count<0)
      throw Error("Invalid open-issue count: "+key);
    else if(count>0)blockers.push("Open "+key+" issues: "+count);
  }
  if(!raw.cases||typeof raw.cases!=="object"||Array.isArray(raw.cases)||
    Object.keys(raw.cases).sort().join("|")!==
      ALPHA_CASES.map(([id])=>id).sort().join("|"))
    throw Error("Evidence must contain all 20 exact ALPHA identifiers");
  let passed=0,failed=0,blocked=0;
  for(const [id,requiredMode] of ALPHA_CASES){
    const item=raw.cases[id];
    if(!item||typeof item!=="object"||Array.isArray(item)||
       !allowedStatus.has(item.status)||item.mode!==requiredMode)
      throw Error("Invalid status or test mode: "+id);
    if(item.status==="pass"){
      exactKeys(item,["status","mode","reviewer","observedAt","evidenceSha256"],id);
      if(typeof item.reviewer!=="string"||!/^[A-Za-z][A-Za-z0-9_-]{1,24}$/.test(item.reviewer)||
         typeof item.observedAt!=="string"||!Number.isFinite(Date.parse(item.observedAt))||
         !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.observedAt)||
         typeof item.evidenceSha256!=="string"||!HASH.test(item.evidenceSha256))
        throw Error("Missing bounded reviewer/time/evidence SHA for "+id);
      passed++;
    }else{
      exactKeys(item,["status","mode","reason"],id);
      if(!cleanReason(item.reason))
        throw Error("Invalid blocked/failure reason for "+id);
      blockers.push(id+": "+item.status);
      if(item.status==="fail")failed++;else blocked++;
    }
  }
  return {readyForHumanReview:blockers.length===0,
    passed,failed,blocked,total:ALPHA_CASES.length,
    blockers};
}
function usage() {
  console.error("Usage: node scripts/alpha-readiness.mjs init|check <local-report.json> <full-40-character-Git-SHA>");
  process.exitCode=2;
}
const invoked=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked){
  const [, ,mode,path,sha]=process.argv;
  if(!["init","check"].includes(mode)||!path||!sha){usage();}
  else{
    try{
      const expected=fullCommit(sha),file=resolve(path);
      if(mode==="init"){
        const template=blankReport(expected);
        mkdirSync(dirname(file),{recursive:true,mode:0o700});
        writeFileSync(file,JSON.stringify(template,null,2)+"\n",{flag:"wx",mode:0o600});
        console.log("Created blocked-only manual acceptance template. No real test has been marked passed.");
      }else{
        const report=JSON.parse(readFileSync(file,"utf8"));
        const result=checkAlphaEvidence(report,expected);
        console.log("Manual acceptance inventory:",result.passed+"/"+result.total,
          "pass;",result.failed,"fail;",result.blocked,"blocked.");
        for(const blocker of result.blockers)console.log("BLOCKED:",blocker);
        if(result.readyForHumanReview){
          console.log("Inventory complete; independent human verification of the evidence is still required.");
        }else process.exitCode=1;
      }
    }catch(error){
      console.error("Evidence gate failed:",
        error instanceof Error?error.message:"invalid report");
      process.exitCode=1;
    }
  }
}
