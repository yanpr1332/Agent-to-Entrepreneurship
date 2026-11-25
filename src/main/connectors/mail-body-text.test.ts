import {describe,expect,it} from "vitest";
import {extractApprovedMailText} from "./mail-body-text";
const raw=(s:string)=>Buffer.from(s,"utf8");
describe("on-demand mail MIME text privacy and strict limits",()=>{
  it("extracts bounded UTF-8 plain text without active HTML",()=>{
    const source=raw("From: Teacher\r\nSubject: Homework\r\n"+
      "Content-Type: text/plain; charset=utf-8\r\n\r\n"+
      "提交作业，截止日期 2026-12-14");
    expect(extractApprovedMailText(source)).toContain("截止日期 2026-12-14");
  });
  it("ignores HTML and attachment parts in multipart alternative",()=>{
    const mixed=raw('Content-Type: multipart/mixed; boundary="b"\r\n\r\n'+
      '--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+
      'Complete your lab report\r\n'+
      '--b\r\nContent-Type: text/html\r\n\r\n<script>alert("evil")</script>\r\n'+
      '--b\r\nContent-Type: text/plain; charset=utf-8\r\n'+
      'Content-Disposition: attachment; filename="private.txt"\r\n\r\n'+
      'private contents\r\n--b--\r\n');
    const result=extractApprovedMailText(mixed);
    expect(result).toContain("Complete your lab report");
    expect(result).not.toContain("private contents");
    expect(result).not.toContain("<script>");
  });
  it("rejects HTML-only, malformed and oversized mail without promoting attachments",()=>{
    for(const value of [
      raw("Content-Type: text/html\r\n\r\n<html>secret</html>"),
      raw("bad headers"),
      raw("Content-Type: text/plain\r\n\r\nx".repeat(4000)),
    ])expect(()=>extractApprovedMailText(value)).toThrow();
  });
  it("decodes base64 text and removes control characters",()=>{
    const b=raw("Content-Type: text/plain; charset=utf-8\r\n"+
      "Content-Transfer-Encoding: base64\r\n\r\n"+
      Buffer.from("Hello world\nImportant date 2026-12-15","utf8").toString("base64"));
    expect(extractApprovedMailText(b)).toContain("Important date 2026-12-15");
  });
});
