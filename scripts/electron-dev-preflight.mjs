#!/usr/bin/env node
/**
 * Offline Electron development startup doctor. No downloads, npm install,
 * OS permission changes or user-data mutations are performed here.
 * A missing binary must never be disguised as an application source bug.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executableByPlatform={
  win32:"electron.exe",
  darwin:"Electron.app/Contents/MacOS/Electron",
  linux:"electron",
};

export function inspectElectronBinary(root,platform=process.platform){
  if(!Object.hasOwn(executableByPlatform,platform))
    return {ok:false,reason:"unsupported-platform"};
  const electronRoot=join(resolve(root),"node_modules","electron");
  const expected=executableByPlatform[platform];
  let packageInfo;
  try {
    packageInfo=JSON.parse(readFileSync(join(electronRoot,"package.json"),"utf8"));
  } catch {
    return {ok:false,reason:"missing-package"};
  }
  if(!packageInfo||typeof packageInfo.version!=="string"||
      !/^[0-9]+\.[0-9]+\.[0-9]+/.test(packageInfo.version))
    return {ok:false,reason:"invalid-package"};
  let pathValue;
  try {pathValue=readFileSync(join(electronRoot,"path.txt"),"utf8").trim();}
  catch {return {ok:false,reason:"missing-binary",version:packageInfo.version};}
  // Restrict to the official platform-specific relative binary path. It may
  // never escape node_modules/electron/dist through a modified path.txt.
  if(pathValue!==expected)
    return {ok:false,reason:"unexpected-binary-path",version:packageInfo.version};
  try{
    if(!lstatSync(join(electronRoot,"dist",expected)).isFile())
      return {ok:false,reason:"missing-binary",version:packageInfo.version};
  }catch{
    return {ok:false,reason:"missing-binary",version:packageInfo.version};
  }
  return {ok:true,version:packageInfo.version,platform};
}

export function electronDoctorMessage(result){
  if(result.ok)
    return "Electron "+result.version+" executable found for "+result.platform+".";
  switch(result.reason){
    case "unsupported-platform":
      return "This development script supports Windows, macOS and Linux only.";
    case "missing-package":
      return "Electron npm package is missing. Run npm ci in the Study Anchor repository first.";
    case "invalid-package":
      return "Electron npm package metadata is invalid. Reinstall locked dependencies with npm ci.";
    default:
      return [
        "Electron npm package exists, but its executable is not installed correctly.",
        "The electron-vite 'Electron uninstall' error means the local Electron binary is unavailable.",
        "Run: npm run setup:electron",
        "This explicitly downloads the Electron version locked in package-lock.json.",
        "If download fails, check the network or select a trusted mirror with ELECTRON_MIRROR.",
        "Then rerun: npm run doctor:electron",
        "Do not delete your local Study Anchor user data or disable the Windows sandbox.",
      ].join("\n");
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=inspectElectronBinary(process.cwd());
  const output=electronDoctorMessage(result);
  if(result.ok){
    console.log("[Study Anchor] "+output);
  } else {
    console.error("[Study Anchor] Development startup check failed:\n"+output);
    process.exitCode=1;
  }
}
