import { describe, expect, it } from "vitest";
import { ImapInboxReader, decodeMailHeader, parseMailHeaderLiteral } from "./mail-imap";
import type { MailWire } from "./mail-wire";

class TranscriptWire implements MailWire {
  writes: string[] = [];
  closed = false;
  constructor(private readonly lines: string[],private readonly literals:Buffer[] = []) {}
  async readLine():Promise<string>{
    const next=this.lines.shift();
    if (next===undefined) throw new Error("Unexpected IMAP transcript EOF");
    return next;
  }
  async readBytes(n:number):Promise<Buffer>{
    const next=this.literals.shift();
    if (!next || next.length!==n) throw new Error("Unexpected literal framing");
    return next;
  }
  async write(value:string|Buffer):Promise<void>{this.writes.push(value.toString());}
  close():void{this.closed=true;}
}
const credentials={email:"student@sjtu.edu.cn",username:"student",password:"secret"};

describe("IMAP read-only inbox",()=>{
  it("fetches only recent header fields and preserves UIDVALIDITY",async()=>{
    const first=Buffer.from("From: Teacher <t@sjtu.edu.cn>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Tue, 10 Nov 2026 09:00:00 +0800\r\nMessage-ID: <x@sjtu.edu.cn>\r\n\r\n","utf8");
    const second=Buffer.from("From: Another <a@sjtu.edu.cn>\r\nSubject: Exam\r\n\r\n");
    const wire=new TranscriptWire([
      "* OK IMAP4 ready",
      "A0001 OK authenticated",
      "* FLAGS (\\Seen)",
      "* OK [UIDVALIDITY 128] valid",
      "A0002 OK EXAMINE completed",
      "* SEARCH 3 5",
      "A0003 OK SEARCH completed",
      `* 2 FETCH (UID 5 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${first.length}}`,
      ")",
      `* 1 FETCH (UID 3 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${second.length}}`,
      ")",
      "A0004 OK UID FETCH completed",
    ],[first,second]);
    const client=new ImapInboxReader(async()=>wire);
    const response=await client.readRecent(credentials);
    expect(response.uidValidity).toBe(128);
    expect(response.messages).toHaveLength(2);
    expect(response.messages[0]).toMatchObject({uid:5,uidValidity:128,subject:"你好"});
    expect(wire.writes.join("")).toContain('EXAMINE "INBOX"');
    expect(wire.writes.join("")).toContain("BODY.PEEK[HEADER.FIELDS");
    expect(wire.writes.join("")).not.toContain("STORE");
    expect(wire.closed).toBe(true);
  });

  it("fails closed when server omits UIDVALIDITY",async()=>{
    const wire=new TranscriptWire([
      "* OK ready","A0001 OK authenticated","A0002 OK EXAMINE completed",
    ]);
    await expect(new ImapInboxReader(async()=>wire).readRecent(credentials))
      .rejects.toThrow("UIDVALIDITY");
    expect(wire.closed).toBe(true);
  });


  it("retrieves one approved UID with EXAMINE + BODY.PEEK and no STORE",async()=>{
    const bytes=Buffer.from("From: Teacher\r\nSubject: Lab\r\n"+
      "Content-Type: text/plain; charset=utf-8\r\n\r\nLab due 2026-12-16");
    const wire=new TranscriptWire([
      "* OK connected","A0001 OK login","* FLAGS (\\Seen)",
      "* OK [UIDVALIDITY 4] stable","A0002 OK selected",
      "* 1 FETCH (UID 7 BODY[]<0> {"+bytes.length+"}",
      ")","A0003 OK fetched",
    ],[bytes]);
    const result=await new ImapInboxReader(async()=>wire).readBody(credentials,7,4);
    expect(result.envelope).toMatchObject({uid:7,uidValidity:4,subject:"Lab"});
    expect(result.body).toContain("Lab due 2026-12-16");
    expect(wire.writes.join("")).toContain("UID FETCH 7 (UID BODY.PEEK[]<0.65536>)");
    expect(wire.writes.join("")).not.toContain(" STORE ");
    expect(wire.closed).toBe(true);
  });
  it("refuses an invalid UIDVALIDITY before IMAP body retrieval",async()=>{
    const wire=new TranscriptWire([
      "* OK connected","A0001 OK login","* OK [UIDVALIDITY 8] changed","A0002 OK selected",
    ]);
    await expect(new ImapInboxReader(async()=>wire).readBody(credentials,7,4))
      .rejects.toThrow("UIDVALIDITY changed");
    expect(wire.writes.join("")).not.toContain("BODY.PEEK[]");
    expect(wire.closed).toBe(true);
  });
  it("decodes and sanitizes RFC 2047 header text",()=>{
    expect(decodeMailHeader("=?UTF-8?B?5L2g5aW9?=")).toBe("你好");
    expect(decodeMailHeader("Hello\r\nBcc: fake")).not.toContain("\r");
    expect(parseMailHeaderLiteral(Buffer.from("Subject: Subject\r\n\r\n"),1,2).subject).toBe("Subject");
  });
});
