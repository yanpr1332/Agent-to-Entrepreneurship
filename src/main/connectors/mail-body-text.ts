/** Bounded, text-only extraction of explicitly approved RFC822 messages.
 * Never return HTML, attachments, active content or raw MIME to an AI prompt. */
const MAX_PARTS=24;
function headerPart(raw:string):{head:string;body:string}{
  const match=/\r?\n\r?\n/.exec(raw);
  if(!match||match.index===undefined)throw Error("Mail body has incomplete MIME headers");
  return {head:raw.slice(0,match.index),body:raw.slice(match.index+match[0].length)};
}
function field(head:string,name:string):string{
  const unfolded=head.replace(/\r?\n[ \t]+/g," ");
  const line=unfolded.split(/\r?\n/).find(x=>x.toLowerCase().startsWith(name+":"));
  return line?.slice(name.length+1).trim()??"";
}
function decoded(content:string,encoding:string,charset:string):string{
  let bytes:Buffer;
  if(encoding==="base64"){
    const input=content.replace(/\s/g,"");
    if(!/^[a-z0-9+/]*={0,2}$/i.test(input))throw Error("Invalid encoded mail body");
    bytes=Buffer.from(input,"base64");
  }else if(encoding==="quoted-printable"){
    const input=content.replace(/=\r?\n/g,"");
    const data:number[]=[];
    for(let i=0;i<input.length;i++){
      if(input[i]==="="&&/^[a-f0-9]{2}$/i.test(input.slice(i+1,i+3))){
        data.push(parseInt(input.slice(i+1,i+3),16));i+=2;
      }else data.push(input.charCodeAt(i)&255);
    }
    bytes=Buffer.from(data);
  }else if(encoding==="7bit"||encoding==="8bit"||encoding==="binary"||!encoding){
    bytes=Buffer.from(content,"latin1");
  }else throw Error("Unsupported mail body encoding");
  if(bytes.length>65536)throw Error("Mail body exceeded approved read limit");
  try{return new TextDecoder(charset||"utf-8",{fatal:false}).decode(bytes);}
  catch{throw Error("Unsupported mail body charset");}
}
function plainMime(raw:string,depth=0):string[]{
  if(depth>4)throw Error("MIME structure too deep");
  const {head,body}=headerPart(raw);
  const disposition=field(head,"content-disposition");
  if(/\battachment\b/i.test(disposition)||/filename\s*=/i.test(disposition)||
     /filename\s*=/i.test(field(head,"content-type")))return [];
  const type=field(head,"content-type")||"text/plain; charset=utf-8";
  if(/^multipart\//i.test(type)){
    const boundary=/boundary\s*=\s*(?:"([^"]{1,70})"|([a-z0-9'()+_,./:=?-]{1,70}))/i.exec(type)?.[1]||
      /boundary\s*=\s*(?:"([^"]{1,70})"|([a-z0-9'()+_,./:=?-]{1,70}))/i.exec(type)?.[2];
    if(!boundary)throw Error("Multipart mail body missing boundary");
    const segments=body.split("--"+boundary);
    if(segments.length>MAX_PARTS+2)throw Error("Mail contains too many MIME parts");
    const texts:string[]=[];
    for(const part of segments.slice(1)){
      if(part.startsWith("--"))break;
      const value=part.replace(/^\r?\n/,"").replace(/\r?\n$/,"");
      if(value.trim())texts.push(...plainMime(value,depth+1));
    }
    return texts;
  }
  if(!/^text\/plain(?:\s*;|$)/i.test(type))return [];
  const charset=/charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  const encoding=field(head,"content-transfer-encoding").toLowerCase();
  return [decoded(body,encoding,(charset?.[1]||charset?.[2]||"utf-8").toLowerCase())];
}
export function extractApprovedMailText(message:Buffer):string{
  if(message.length>65536||message.length<8)throw Error("Invalid mail body length");
  const raw=message.toString("latin1");
  const text=plainMime(raw).join("\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g," ")
    .trim();
  if(!text)throw Error("Selected mail has no supported text/plain body");
  return text.slice(0,2400);
}
