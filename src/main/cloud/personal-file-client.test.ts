import {describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {SharedCloudClient} from "./supabase-client";

const URL="https://study-anchor-test.supabase.co";
const KEY="sb_publishable_abcdefghijklmnopqrstuvwxyz12345";
const USER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const ID="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const DATA=Buffer.from("synthetic note");
const SHA=createHash("sha256").update(DATA).digest("hex");
const entry={fileId:ID,filename:"notes.md",sha256:SHA,byteLength:DATA.length,
  version:1,updatedAt:"2026-11-25T02:03:04.000Z"};

describe("V02 private file RPC uses only normal JWT and validates server payloads",()=>{
  it("roundtrips list, content, CAS upload and tombstone via fixed RPCs",async()=>{
    const calls:string[]=[];
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      const h=init.headers as Record<string,string>;
      expect(h.apikey).toBe(KEY);
      expect(init.redirect).toBe("error");
      if(url.includes("auth/v1/token")){
        expect(h.Authorization).toBe("Bearer "+KEY);
        return new Response(JSON.stringify({access_token:"jwt-owner",
          refresh_token:"refresh",expires_in:3600,
          user:{id:USER,email:"test@example.edu"}}));
      }
      expect(h.Authorization).toBe("Bearer jwt-owner");
      expect(url).toMatch(/^https:\/\/study-anchor-test\.supabase\.co\/rest\/v1\/rpc\/ate_file_/);
      const rpc=url.split("/").at(-1);
      calls.push(rpc!);
      const body=JSON.parse(String(init.body)) as Record<string,unknown>;
      if(rpc==="ate_file_list"){
        expect(body).toEqual({});
        return new Response(JSON.stringify([entry]));
      }
      if(rpc==="ate_file_get"){
        expect(body).toEqual({p_file_id:ID});
        return new Response(JSON.stringify({
          fileId:ID,filename:"notes.md",sha256:SHA,byteLength:DATA.length,
          version:1,base64:DATA.toString("base64"),
        }));
      }
      if(rpc==="ate_file_apply"){
        expect(body.p_file_id).toBe(ID);
        if(body.p_delete){
          expect(body).toEqual({
            p_file_id:ID,p_base_version:1,p_filename:null,p_sha256:null,
            p_byte_length:null,p_base64:null,p_delete:true,
          });
        }else{
          expect(body).toEqual({
            p_file_id:ID,p_base_version:0,p_filename:"notes.md",p_sha256:SHA,
            p_byte_length:DATA.length,p_base64:DATA.toString("base64"),
            p_delete:false,
          });
        }
        return new Response(JSON.stringify({status:"accepted",version:body.p_delete?2:1}));
      }
      throw Error("unexpected RPC");
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl:URL,publishableKey:KEY});
    await expect(cloud.listPersonalFiles()).rejects.toThrow("Log in");
    await cloud.login({email:"test@example.edu",password:"valid-password"});
    expect(await cloud.listPersonalFiles()).toEqual([entry]);
    expect(await cloud.readPersonalFile(ID)).toMatchObject({base64:DATA.toString("base64")});
    expect(await cloud.applyPersonalFile({fileId:ID,baseVersion:0,filename:"notes.md",
      sha256:SHA,byteLength:DATA.length,base64:DATA.toString("base64")}))
      .toEqual({status:"accepted",version:1});
    expect(await cloud.deletePersonalFile(ID,1))
      .toEqual({status:"accepted",version:2});
    expect(calls).toEqual(["ate_file_list","ate_file_get","ate_file_apply","ate_file_apply"]);
  });

  it("blocks malformed file responses and URL payloads before returning bytes",async()=>{
    const fetcher=vi.fn(async(url:string)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"jwt",refresh_token:"refresh",expires_in:3600,
        user:{id:USER,email:"test@example.edu"},
      }));
      return new Response(JSON.stringify({
        fileId:ID,filename:"../danger.txt",sha256:SHA,
        version:1,byteLength:DATA.length,base64:DATA.toString("base64"),
      }));
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl:URL,publishableKey:KEY});
    await cloud.login({email:"test@example.edu",password:"valid-password"});
    await expect(cloud.readPersonalFile(ID)).rejects.toThrow();
    await expect(cloud.applyPersonalFile({fileId:ID,baseVersion:0,filename:"bad.exe",
      sha256:SHA,byteLength:DATA.length,base64:DATA.toString("base64")}))
      .rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
