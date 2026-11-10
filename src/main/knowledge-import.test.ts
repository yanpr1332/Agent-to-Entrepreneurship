import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSelectedKnowledgeText } from "./knowledge-import";

const dirs:string[]=[];
function fixture():string{
  const dir=mkdtempSync(join(tmpdir(),"ate-kb-import-"));dirs.push(dir);return dir;
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe("native-picker-only local text import security",()=>{
  it("reads UTF-8 Markdown and never modifies its original content",async()=>{
    const dir=fixture(),path=join(dir,"学习笔记.md");
    writeFileSync(path,"\ufeff# 光合作用\n原文证据");
    const result=await readSelectedKnowledgeText(path);
    expect(result).toMatchObject({title:"学习笔记.md",format:"markdown",text:"# 光合作用\n原文证据"});
  });

  it("rejects non-text extensions, large content, invalid UTF-8 and links",async()=>{
    const dir=fixture();
    const file=join(dir,"safe.txt");writeFileSync(file,"safe");
    // Windows CI accounts may not have the privilege to create symlinks.
    const link=join(dir,"link.txt");
    try {
      symlinkSync(file,link);
      await expect(readSelectedKnowledgeText(link)).rejects.toThrow("regular text");
    } catch(error) {
      if(!["EPERM","EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))throw error;
    }
    const fake=join(dir,"image.png");writeFileSync(fake,"picture");
    await expect(readSelectedKnowledgeText(fake)).rejects.toThrow("Markdown and TXT");
    const bad=join(dir,"broken.md");writeFileSync(bad,Buffer.from([0xc3,0x28]));
    await expect(readSelectedKnowledgeText(bad)).rejects.toThrow("UTF-8");
    const large=join(dir,"large.md");writeFileSync(large,"x".repeat(2*1024*1024+1));
    await expect(readSelectedKnowledgeText(large)).rejects.toThrow("2 MiB");
  });
});
