#!/usr/bin/env node
/**
 * Offline integrity check for a manually downloaded unsigned internal Alpha
 * artifact directory. Never executes binaries or contacts a server.
 * IMPORTANT: SHA files inside the same artifact are NOT a signature.
 */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHA=/^[a-f0-9]{64}$/i;
const COMMIT=/^[a-f0-9]{40}$/i;
function safeName(name) {
  return typeof name==="string" && name.length>0 && name.length<=200 &&
    !/[\/\\\x00-\x1f\x7f]/.test(name) && name!=="." && name!==".." &&
    !name.startsWith(".") && /study[\s._-]*anchor/i.test(name);
}
function regularFile(path) {
  const item=lstatSync(path);
  if (!item.isFile() || item.isSymbolicLink() || item.nlink!==1)
    throw Error("Artifact must be an ordinary single-link file");
  return item.size;
}
async function sha256(path) {
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyDownloadedAlpha(directory,target,expectedCommit) {
  if(!["win","mac"].includes(target))throw Error("Specify platform win or mac");
  if(typeof expectedCommit!=="string" || !COMMIT.test(expectedCommit))
    throw Error("Provide the independently verified full 40-character Git commit");
  const root=resolve(directory);
  const checksumPath=join(root,"SHA256SUMS.txt");
  const evidencePath=join(root,"BUILD_EVIDENCE.json");
  if(regularFile(checksumPath)>20000 || regularFile(evidencePath)>50000)
    throw Error("Artifact manifests exceed size limits");
  const checksums=readFileSync(checksumPath,"utf8").trimEnd().split("\n");
  const expected=new Map();
  for(const line of checksums) {
    const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
    if(!match || !safeName(match[2]) || expected.has(match[2]))
      throw Error("Malformed or duplicate SHA256SUMS entry");
    expected.set(match[2],match[1]);
  }
  let evidence;
  try{evidence=JSON.parse(readFileSync(evidencePath,"utf8"));}
  catch{throw Error("Build evidence is not valid JSON");}
  if(!evidence || evidence.schema!==1 || evidence.product!=="Study Anchor" ||
      evidence.target!==target || evidence.commit!==expectedCommit ||
      evidence.signed!==false || evidence.notarized!==false ||
      !Array.isArray(evidence.installers) ||
      evidence.installers.length!==expected.size || expected.size<1)
    throw Error("Build evidence does not match the expected internal unsigned commit/platform");
  const suffixes=target==="win"?[".exe"]:[".dmg",".zip"];
  for(const suffix of suffixes)
    if(![...expected.keys()].some(name=>name.toLowerCase().endsWith(suffix)))
      throw Error("Missing required platform installer: "+suffix);
  const localInstallers=readdirSync(root).filter(name=>/\.(exe|dmg|zip)$/i.test(name));
  if(localInstallers.length!==expected.size ||
      localInstallers.some(name=>!expected.has(name)))
    throw Error("Unexpected installer or missing checksum entry");
  const seen=new Set();
  for(const entry of evidence.installers) {
    if(!entry || !safeName(entry.name) || seen.has(entry.name) ||
        !expected.has(entry.name) || !SHA.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes<1024*1024 ||
        !suffixes.some(x=>entry.name.toLowerCase().endsWith(x)))
      throw Error("Invalid or inconsistent installer evidence");
    seen.add(entry.name);
    const file=join(root,entry.name),size=regularFile(file);
    if(size!==entry.bytes)throw Error("Installer size differs from build evidence");
    const actual=await sha256(file);
    if(actual!==entry.sha256 || actual!==expected.get(entry.name))
      throw Error("Installer SHA-256 mismatch: "+entry.name);
  }
  return {platform:target,commit:expectedCommit,verifiedFiles:seen.size,
    unsigned:true};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=await verifyDownloadedAlpha(process.argv[2]??"",process.argv[3],process.argv[4]);
    console.log("PASS: local installer hashes and claimed commit match:",result.platform,
      result.verifiedFiles,"file(s). UNSIGNED; not an authenticity or GUI-install proof.");
  }catch(error){
    console.error("BLOCKED:",error instanceof Error?error.message:"Integrity check failed");
    process.exitCode=1;
  }
}
