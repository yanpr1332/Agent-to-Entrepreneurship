import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { lstat, realpath, readFile } from "node:fs/promises";

export const MAX_PDF_BYTES=12*1024*1024;
export const MAX_PDF_PAGES=120;
export const MAX_EXTRACTED_BYTES=2*1024*1024;
const MAX_PAGE_EXTRACTED_CHARS=100_000;

export interface SelectedKnowledgePdf {
  sourcePath:string;
  title:string;
  format:"pdf";
  fileHash:string;
  byteLength:number;
  pages:string[];
}

/** Pure text extraction. No rendering, embedded scripts, remote fetch, OCR or file writes. */
export async function extractPdfText(bytes:Uint8Array):Promise<string[]> {
  if(bytes.length===0||bytes.length>MAX_PDF_BYTES ||
      new TextDecoder().decode(bytes.subarray(0,8)).indexOf("%PDF-")<0)
    throw Error("Selected PDF has an invalid signature or exceeds 12 MiB");
  // Load the ESM parser only when a user explicitly selects a PDF.
  const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const options={
    data:new Uint8Array(bytes),
    disableFontFace:true,
    useSystemFonts:false,
    isEvalSupported:false,
    stopAtErrors:true,
    disableAutoFetch:true,
    disableStream:true,
    enableScripting:false,
  };
  const loading=getDocument(options);
  try{
    const pdf=await loading.promise;
    if(pdf.numPages<1||pdf.numPages>MAX_PDF_PAGES)
      throw Error("PDF exceeds the 120-page extraction limit");
    const pages:string[]=[];
    let total=0;
    for(let number=1;number<=pdf.numPages;number++){
      const page=await pdf.getPage(number);
      const extracted=await page.getTextContent();
      const parts:string[]=[];
      for(const item of extracted.items) {
        if("str" in item && typeof item.str==="string"){
          parts.push(item.str);
          if(item.hasEOL)parts.push("\n");
          else parts.push(" ");
        }
      }
      page.cleanup();
      const text=parts.join("").replace(/[ \t]+\n/g,"\n").trim();
      if(text.length>MAX_PAGE_EXTRACTED_CHARS)
        throw Error("PDF page contains too much extractable text");
      total+=Buffer.byteLength(text,"utf8");
      if(total>MAX_EXTRACTED_BYTES)
        throw Error("PDF extracted text exceeds 2 MiB index limit");
      pages.push(text);
    }
    if(!pages.some(p=>p.trim())) {
      throw Error("PDF has no selectable text. Scanned/image-only PDFs require OCR (not available yet)");
    }
    return pages;
  }catch(error){
    if(error instanceof Error && /PDF exceeds|PDF page contains|extracted text|no selectable text/.test(error.message))
      throw error;
    throw Error("Unable to safely extract PDF text. The file may be encrypted or malformed");
  }finally{
    await loading.destroy();
  }
}

export async function readSelectedKnowledgePdf(path:string):Promise<SelectedKnowledgePdf>{
  if(!path || typeof path!=="string")throw Error("No PDF selected");
  const entry=await lstat(path);
  if(!entry.isFile()||entry.isSymbolicLink()||entry.size>MAX_PDF_BYTES)
    throw Error("Only regular PDF files up to 12 MiB can be imported");
  if(extname(path).toLowerCase()!==".pdf")
    throw Error("Only PDF files are accepted in this reader");
  const resolved=await realpath(path);
  const bytes=await readFile(resolved);
  if(bytes.length>MAX_PDF_BYTES)throw Error("PDF exceeds the 12 MiB limit");
  const pages=await extractPdfText(new Uint8Array(bytes));
  return {
    sourcePath:resolved,title:basename(resolved).slice(0,255),format:"pdf",
    fileHash:createHash("sha256").update(bytes).digest("hex"),
    byteLength:bytes.length,pages,
  };
}
