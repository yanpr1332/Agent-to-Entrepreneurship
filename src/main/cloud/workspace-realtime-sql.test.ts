import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../../../supabase/migrations/20261124_ate_workspace_realtime_hints.sql",
  import.meta.url),"utf8").toLowerCase();

describe("ALPHA-SYNC-003A optional test-project Realtime publication",()=>{
  it("adds only the two explicitly allowed workspace tables",()=>{
    expect(sql).toContain("alter publication supabase_realtime add table public.ate_workspace_messages");
    expect(sql).toContain("alter publication supabase_realtime add table public.ate_workspace_tasks");
    expect(sql).toContain("pg_publication_tables");
    expect(sql).toContain("not exists");
    expect(sql).not.toContain("alter publication supabase_realtime add table public.ate_workspace_members");
    expect(sql).not.toContain("alter publication supabase_realtime add table public.ate_workspace_invites");
    expect(sql).not.toContain("alter publication supabase_realtime add table public.personal");
    expect(sql).not.toContain("add all tables");
  });
  it("does not weaken RLS or grant privileged access",()=>{
    const code=sql.replace(/--[^\n]*/g,"");
    expect(code).not.toMatch(/\b(disable row level security|create policy|grant |service_role|replica identity full)\b/);
    expect(code).not.toContain("create publication");
    expect(code).toContain("pg_publication");
  });
});
