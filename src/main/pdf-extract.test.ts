import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {extractPdfText,readSelectedKnowledgePdf} from "./pdf-extract";

const dirs:string[]=[];
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});

/** Minimal valid two-page, selectable-text PDF fixture. No external PDF generator. */
function makePdf(lines:string[]):Buffer {
  const parts:string[]=[];
  const pageRefs=lines.map((_,i)=>3+i*2);
  const fontId=3+lines.length*2;
  parts[0]="<< /Type /Catalog /Pages 2 0 R >>";
  parts[1]=`<< /Type /Pages /Kids [${pageRefs.map(n=>n+" 0 R").join(" ")}] /Count ${lines.length} >>`;
  lines.forEach((line,i)=>{
    const page=3+i*2,stream=page+1;
    parts[page-1]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${stream} 0 R >>`;
    const contents=`BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g,m=>"\\"+m)}) Tj ET\n`;
    parts[stream-1]=`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}endstream`;
  });
  parts[fontId-1]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let output="%PDF-1.4\n";
  const offsets=[0];
  parts.forEach((object,i)=>{
    offsets.push(Buffer.byteLength(output));
    output+=`${i+1} 0 obj\n${object}\nendobj\n`;
  });
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 ${parts.length+1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset=>{output+=`${String(offset).padStart(10,"0")} 00000 n \n`;});
  output+=`trailer\n<< /Size ${parts.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output,"latin1");
}
describe("PDF text parser: real page provenance",()=>{
  it("extracts separate page text from a real two-page PDF",async()=>{
    const pages=await extractPdfText(makePdf(["Page One Evidence","Page Two Mitosis"]));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Page One Evidence");
    expect(pages[1]).toContain("Page Two Mitosis");
  });
  it("rejects encrypted/binary impostors and resource-heavy files",async()=>{
    await expect(extractPdfText(new Uint8Array(Buffer.from("NOT_A_PDF")))).rejects.toThrow("signature");
    await expect(extractPdfText(new Uint8Array(12*1024*1024+1))).rejects.toThrow("signature");
    const dir=mkdtempSync(join(tmpdir(),"ate-pdf-"));dirs.push(dir);
    const path=join(dir,"notes.pdf");writeFileSync(path,makePdf(["Select Text"]));
    const pdf=await readSelectedKnowledgePdf(path);
    expect(pdf).toMatchObject({format:"pdf",title:"notes.pdf",pages:["Select Text"]});
    expect(pdf.fileHash).toMatch(/^[a-f0-9]{64}$/);
    const other=join(dir,"bad.png");writeFileSync(other,makePdf(["Not PDF extension"]));
    await expect(readSelectedKnowledgePdf(other)).rejects.toThrow("Only PDF");
    const link=join(dir,"link.pdf");
    try{symlinkSync(path,link);await expect(readSelectedKnowledgePdf(link)).rejects.toThrow("regular PDF");}
    catch(e){if(!["EPERM","EACCES"].includes((e as NodeJS.ErrnoException).code??""))throw e;}
  });
});
