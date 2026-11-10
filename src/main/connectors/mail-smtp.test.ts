import { describe, expect, it } from "vitest";
import { SmtpSender, formatSmtpMessage } from "./mail-smtp";
import { parseMailDraft } from "../../shared/mail-model";
import type { MailWire } from "./mail-wire";

class SmtpTranscript implements MailWire {
  writes:string[]=[];
  closed=false;
  constructor(private readonly replies:string[]){}
  async readLine(){const v=this.replies.shift();if(!v)throw Error("SMTP transcript EOF");return v;}
  async readBytes(_n:number):Promise<Buffer>{throw Error("SMTP should not read literals");}
  async write(value:string|Buffer){this.writes.push(value.toString());}
  close(){this.closed=true;}
}
const auth={email:"student@sjtu.edu.cn",username:"student",password:"private-pass"};

describe("SMTP explicit single-message transport",()=>{
  it("uses verified TLS session, AUTH PLAIN and sends one bounded plain-text MIME message",async()=>{
    const wire=new SmtpTranscript([
      "220 mail.sjtu.edu.cn ESMTP","250-hello","250 AUTH PLAIN LOGIN",
      "235 authenticated","250 sender ok","250 recipient ok",
      "354 start mail input","250 queued","221 goodbye",
    ]);
    const sender=new SmtpSender(async(host,port)=>{
      expect(host).toBe("mail.sjtu.edu.cn");
      expect(port).toBe(465);
      return wire;
    });
    await sender.send(auth,parseMailDraft({to:["dest@sjtu.edu.cn"],subject:"课程安排",body:"你好！\n请查收"}));
    const transcript=wire.writes.join("");
    expect(transcript).toContain("AUTH PLAIN ");
    expect(transcript).toContain("RCPT TO:<dest@sjtu.edu.cn>");
    expect(transcript).toContain("Content-Transfer-Encoding: base64");
    expect(transcript).toContain("\r\n.\r\n");
    expect(transcript).not.toContain("private-pass");
    expect(wire.closed).toBe(true);
  });

  it("does not continue to DATA if authentication is refused",async()=>{
    const wire=new SmtpTranscript([
      "220 ready","250-hello","250 AUTH PLAIN","535 bad credentials",
    ]);
    await expect(new SmtpSender(async()=>wire).send(auth,{
      to:["one@example.org"],subject:"Hi",body:"Test",
    })).rejects.toThrow("could not send");
    expect(wire.writes.join("")).not.toContain("DATA");
  });

  it("marks delivery as uncertain after DATA if acknowledgement is lost",async()=>{
    const wire=new SmtpTranscript([
      "220 ready","250-hello","250 AUTH PLAIN","235 ok",
      "250 sender","250 recipient","354 enter data",
    ]);
    await expect(new SmtpSender(async()=>wire).send(auth,{
      to:["one@example.org"],subject:"Hi",body:"Test",
    })).rejects.toThrow("uncertain");
  });

  it("does not include raw Chinese subject or body in MIME headers",()=>{
    const formatted=formatSmtpMessage("student@sjtu.edu.cn",{
      to:["t@example.org"],subject:"中文",body:"中文正文",
    });
    expect(formatted).toContain("Subject: =?UTF-8?B?");
    expect(formatted).not.toContain("中文正文");
  });
});
