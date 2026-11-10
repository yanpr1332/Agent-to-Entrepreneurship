import { basename, extname } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { readSelectedKnowledgePdf,type SelectedKnowledgePdf } from "./pdf-extract";

export const MAX_KNOWLEDGE_FILE_BYTES=2*1024*1024;

export interface SelectedKnowledgeText {
  sourcePath:string;
  title:string;
  format:"markdown"|"text";
  text:string;
}

/**
 * Main-process only. The selected path comes from a native OS file picker,
 * never from a renderer IPC argument. Reject symlinks and nontext/large files.
 */
export async function readSelectedKnowledgeText(path:string):Promise<SelectedKnowledgeText>{
  if(!path || typeof path!=="string")throw Error("No knowledge file selected");
  const entry=await lstat(path);
  if(!entry.isFile() || entry.isSymbolicLink() ||
     entry.size>MAX_KNOWLEDGE_FILE_BYTES) {
    throw Error("Only regular text files up to 2 MiB can be imported");
  }
  const extension=extname(path).toLowerCase();
  if(extension!==".md" && extension!==".markdown" && extension!==".txt") {
    throw Error("Only Markdown and TXT are supported in this version");
  }
  const canonical=await realpath(path);
  const bytes=await readFile(canonical);
  if(bytes.length>MAX_KNOWLEDGE_FILE_BYTES)throw Error("Selected file exceeded the size limit");
  let text:string;
  try {
    text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  }catch{throw Error("Only UTF-8 text files are supported");}
  if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
  if(!text.trim() || text.includes("\0"))throw Error("Selected file is empty or contains invalid binary data");
  return {
    sourcePath:canonical,
    title:basename(canonical).slice(0,255),
    format:extension===".txt"?"text":"markdown",
    text,
  };
}

/** All paths originate from a trusted native Electron file picker. */
export async function readSelectedKnowledgeFile(path:string):Promise<SelectedKnowledgeText|SelectedKnowledgePdf>{
  if(extname(path).toLowerCase()===".pdf")return readSelectedKnowledgePdf(path);
  return readSelectedKnowledgeText(path);
}
