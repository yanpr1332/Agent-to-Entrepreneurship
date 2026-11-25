import {createHash} from "node:crypto";
import {createReadStream,existsSync,readdirSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const target=process.argv[2];
if(target!=="win"&&target!=="mac")
  throw Error("Pass exact installer platform: win or mac");
const release=fileURLToPath(new URL("../release/",import.meta.url));
if(!existsSync(release))throw Error("electron-builder did not create release directory");
const all=readdirSync(release).filter(x=>!x.includes("/")&&!x.includes("\\"));
const extensions=target==="win"?[".exe"]:[".dmg",".zip"];
const result=[];
for(const extension of extensions){
  const candidates=all.filter(x=>x.toLowerCase().endsWith(extension));
  if(!candidates.length)throw Error("Missing required "+extension+" installer");
  for(const name of candidates){
    if(!/study[\s._-]*anchor/i.test(name))
      throw Error("Installer filename is not branded Study Anchor: "+name);
    const path=join(release,name),size=statSync(path).size;
    if(!Number.isSafeInteger(size)||size<1024*1024)
      throw Error("Installer is suspiciously small: "+name);
    const hash=createHash("sha256");
    for await(const chunk of createReadStream(path))hash.update(chunk);
    result.push({name,bytes:size,sha256:hash.digest("hex")});
  }
}
result.sort((a,b)=>a.name.localeCompare(b.name));
writeFileSync(join(release,"SHA256SUMS.txt"),
  result.map(x=>x.sha256+"  "+x.name).join("\n")+"\n",{flag:"w",mode:0o600});
writeFileSync(join(release,"BUILD_EVIDENCE.json"),JSON.stringify({
  schema:1,product:"Study Anchor",target,commit:process.env.GITHUB_SHA||"local-unverified",
  generatedAt:new Date().toISOString(),signed:false,notarized:false,
  status:"internal-only; real GUI install and recovery acceptance still required",
  installers:result,
},null,2)+"\n",{flag:"w",mode:0o600});
console.log("Verified unsigned internal Alpha installer(s):",
  result.map(x=>x.name+" sha256:"+x.sha256).join(", "));
