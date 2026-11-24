import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../../supabase/migrations/20261124_ate_personal_sync_recovery_inspect.sql",import.meta.url),"utf8");
function body(functionName:string):string{
  const start=sql.indexOf("create or replace function public."+functionName+"(");
  expect(start).toBeGreaterThanOrEqual(0);
  const section=sql.slice(start);
  const begin=section.indexOf("as $$");
  expect(begin).toBeGreaterThanOrEqual(0);
  const end=section.indexOf("$$;",begin+5);
  expect(end).toBeGreaterThan(begin);
  return section.slice(begin+5,end).replace(/--[^\n]*/g,"");
}

describe("ALPHA-SYNC-002H read-only SQL security baseline (static only)",()=>{
  it("keeps the two functions authenticated, SECURITY DEFINER with an empty search path",()=>{
    for(const [name,signature] of [
      ["ate_personal_sync_inspect_device","uuid"],
      ["ate_personal_sync_lookup_receipt","jsonb"],
    ]){
      expect(sql).toContain("create or replace function public."+name+"(");
      expect(sql).toContain("revoke all on function public."+name+"("+signature+") from public,anon;");
      expect(sql).toContain("grant execute on function public."+name+"("+signature+") to authenticated;");
      const section=sql.slice(sql.indexOf("create or replace function public."+name+"("));
      expect(section.split("as $$")[0]).toContain("security definer set search_path = ''");
      const fn=body(name).toLowerCase();
      expect(fn).toContain("auth.uid()");
      // These RPCs must not mutate tables, even when run by a SECURITY DEFINER.
      expect(fn).not.toMatch(/\b(insert\s+into|update\s+|delete\s+from|truncate\s+|execute\s+)\b/);
    }
  });

  it("scopes status, cursor, and saved receipts to auth.uid with no raw payload returned",()=>{
    const inspect=body("ate_personal_sync_inspect_device");
    const receipt=body("ate_personal_sync_lookup_receipt");
    expect(inspect).toContain("where owner_id=v_owner and device_id=p_device_id");
    expect(inspect).toContain("where owner_id=v_owner");
    expect(receipt).toContain("where owner_id=v_owner and operation_id=v_op_id");
    expect(receipt).toContain("v_saved_request is distinct from p_operation");
    expect(receipt).toContain("return jsonb_build_object('status','matched','response',v_saved_response)");
    expect(receipt).not.toContain("v_saved_request)");
  });
});
