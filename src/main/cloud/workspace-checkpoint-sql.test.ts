import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../../../supabase/migrations/20261124_ate_workspace_checkpoint_recovery.sql",
  import.meta.url),"utf8").toLowerCase();
function body(name:string){
  const at=sql.indexOf("create or replace function public."+name+"(");
  expect(at).toBeGreaterThanOrEqual(0);
  const rest=sql.slice(at),start=rest.indexOf("as $$"),end=rest.indexOf("$$;",start+5);
  expect(end).toBeGreaterThan(start);
  return rest.slice(start,end);
}
describe("ALPHA-SYNC-003C test-project-only checkpoint SQL security",()=>{
  it("publishes immutable baseline only behind RLS and authenticated RPCs",()=>{
    expect(sql).toContain("alter table public.ate_workspace_history_checkpoint enable row level security");
    expect(sql).toContain("revoke all on public.ate_workspace_history_checkpoint from public,anon,authenticated");
    expect(sql).not.toContain("grant select on public.ate_workspace_history_checkpoint");
    const fn=body("ate_workspace_history_snapshot");
    expect(fn).toContain("auth.uid()");
    expect(fn).toContain("not public.ate_is_member(p_workspace_id)");
    expect(fn).toContain("checkpoint_cursor=p_checkpoint_cursor");
    expect(fn).toContain("ordinal>p_after");
    expect(fn).toContain("p_limit>100");
    expect(sql).toContain("grant execute on function public.ate_workspace_history_snapshot");
    expect(sql).toContain("to authenticated");
    expect(sql).toContain("security definer set search_path=''");
  });
  it("requires authenticated workspace OWNER before any destructive compaction",()=>{
    const fn=body("ate_workspace_history_compact");
    expect(fn).toContain("auth.uid()");
    expect(fn).toContain("user_id=auth.uid() and role='owner'");
    expect(fn).toContain("lock table public.ate_workspace_messages,public.ate_workspace_tasks");
    expect(fn).toContain("share row exclusive mode");
    expect(fn).toContain("for update");
    expect(fn).toContain("row_number() over(order by source.kind,source.entity_id)");
    expect(fn).toContain("min_cursor=v_cursor");
    expect(fn).toContain("checkpoint_count=v_count");
    expect(fn).toContain("delete from public.ate_workspace_history");
    expect(fn).toContain("cursor<=v_cursor");
    expect(fn).toContain("if v_cursor<=v_min then");
    expect(sql).not.toMatch(/alter\s+table\s+public\.ate_workspace_(?:messages|tasks)\s+disable\s+row\s+level\s+security/);
  });
  it("returns typed expiry instead of silently skipping deleted journal intervals",()=>{
    const fn=body("ate_workspace_history_pull");
    expect(fn).toContain("if p_after<v_min then");
    expect(fn).toContain("'status','expired'");
    expect(fn).toContain("'checkpointcursor',v_checkpoint::text");
    expect(fn).toContain("'totalitems',v_count::text");
    expect(fn).toContain("p_after>v_cursor");
    expect(fn).toContain("not public.ate_is_member(p_workspace_id)");
    expect(fn).toContain("order by cursor asc limit p_limit");
    expect(sql).toContain("check (min_cursor>=0 and min_cursor<=last_cursor");
  });
  it("does not schedule automatic compaction or expose any other personal data table",()=>{
    expect(sql).not.toMatch(/cron\.|pg_cron|create\s+trigger/);
    expect(sql).not.toContain("service_role");
    expect(sql).not.toContain("ate_personal_sync_");
    expect(sql).not.toContain("ate_workspace_invites");
    expect(sql).not.toMatch(/\bcreate\s+policy\b/);
    expect(sql).toContain("commit;");
  });
});
