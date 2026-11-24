import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../../../supabase/migrations/20261124_ate_workspace_durable_history.sql",
  import.meta.url),"utf8").toLowerCase();
function functionSource(name:string):string{
  const at=sql.indexOf("create or replace function public."+name+"(");
  expect(at).toBeGreaterThanOrEqual(0);
  const src=sql.slice(at),begin=src.indexOf("as $$"),end=src.indexOf("$$;",begin+5);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return src.slice(begin,end);
}
describe("ALPHA-SYNC-003B immutable journal / RLS static safety checks",()=>{
  it("enforces scoped commit-order counter locks instead of unsafe sequences",()=>{
    expect(sql).toContain("primary key(workspace_id,cursor)");
    expect(sql).toContain("on conflict(workspace_id)");
    expect(sql).toContain("last_cursor=public.ate_workspace_history_state.last_cursor+1");
    expect(sql).toContain("lock table public.ate_workspace_messages, public.ate_workspace_tasks");
    expect(sql).toContain("share row exclusive mode");
    expect(sql).not.toContain("nextval(");
    expect(sql).toContain("commit;");
  });
  it("backfills existing team messages/tasks and registers insert/update/delete tombstones",()=>{
    expect(sql).toContain("to_jsonb(m)");
    expect(sql).toContain("to_jsonb(t)");
    expect(sql).toContain("where workspace_id=v_workspace");
    expect(sql).toContain("after insert or update or delete on public.ate_workspace_messages");
    expect(sql).toContain("after insert or update or delete on public.ate_workspace_tasks");
    expect(sql).toContain("case when tg_op='delete' then null");
    expect(sql).toContain("if exists(select 1 from public.ate_workspace_history");
    expect(sql).toContain("action='delete' and entity_payload is null");
  });
  it("denies direct journal access and checks auth.uid member inside the only reader RPC",()=>{
    for(const t of ["ate_workspace_history","ate_workspace_history_state"]){
      expect(sql).toContain("alter table public."+t+" enable row level security");
      expect(sql).toContain("revoke all on public."+t+" from public,anon,authenticated");
    }
    const fn=functionSource("ate_workspace_history_pull");
    expect(fn).toContain("auth.uid()");
    expect(fn).toContain("not public.ate_is_member(p_workspace_id)");
    expect(fn).toContain("where workspace_id=p_workspace_id and cursor>p_after");
    expect(fn).toContain("where workspace_id=p_workspace_id and cursor>v_next");
    expect(sql).toContain("security definer set search_path=''");
    expect(sql).toContain("revoke all on function public.ate_workspace_history_pull");
    expect(sql).toContain("grant execute on function public.ate_workspace_history_pull");
    expect(sql).not.toContain("grant select on public.ate_workspace_history");
  });
  it("limits pages to 100 and refuses cursors beyond the server",()=>{
    const fn=functionSource("ate_workspace_history_pull");
    expect(fn).toContain("p_limit > 100");
    expect(fn).toContain("p_after > v_cursor");
    expect(fn).toContain("order by cursor asc limit p_limit");
    expect(fn).toContain("'nextcursor',v_next::text");
    expect(fn).toContain("'servercursor',v_cursor::text");
    expect(fn).toContain("'hasmore',v_more");
  });
});
