import { describe,expect,it } from "vitest";
import {
  requireUuid,requireInvite,validateCloudProject,parseCloudTask,
} from "./cloud-model";

const key="sb_publishable_abcdefghijklmnopqrstuvwxyz12345";
describe("Supabase cloud PoC validation",()=>{
  it("accepts public project settings but rejects secret or local endpoints",()=>{
    expect(validateCloudProject({projectUrl:"https://example-test.supabase.co",publishableKey:key}))
      .toMatchObject({projectUrl:"https://example-test.supabase.co"});
    for(const url of ["http://example-test.supabase.co","https://127.0.0.1",
      "https://example-test.supabase.co/other","https://evil.example.com"]){
      expect(()=>validateCloudProject({projectUrl:url,publishableKey:key})).toThrow();
    }
    expect(()=>validateCloudProject({projectUrl:"https://example.supabase.co",publishableKey:"sb_secret_abcdef"})).toThrow();
  });
  it("rejects malformed IDs, invitation codes and task dates",()=>{
    expect(()=>requireUuid("123")).toThrow();
    expect(()=>requireInvite("123")).toThrow();
    expect(()=>parseCloudTask({title:"Study",dueDate:"2026-02-30"})).toThrow();
    expect(parseCloudTask({title:" Study ",dueDate:"2026-11-25"}))
      .toEqual({title:"Study",dueDate:"2026-11-25",assignedTo:null});
  });
});
