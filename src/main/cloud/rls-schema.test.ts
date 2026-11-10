import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe,expect,it } from "vitest";

/**
 * These tests only review critical DDL controls. Real RLS access must also be
 * tested against an isolated Supabase project using independent user JWTs.
 */
const sql=readFileSync(join(process.cwd(),"supabase/migrations/20261110_ate_workspace_poc.sql"),"utf8");

describe("five-user workspace migration security baselines (static)",()=>{
  it("enables RLS on all exposed shared-data tables",()=>{
    for(const table of ["ate_workspaces","ate_workspace_members",
      "ate_workspace_invites","ate_workspace_messages","ate_workspace_tasks"]){
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
    }
  });
  it("requires authenticated membership for messages and shared tasks",()=>{
    expect(sql).toContain("create policy ate_messages_read");
    expect(sql).toContain("create policy ate_messages_insert");
    expect(sql).toContain("author_id = auth.uid()");
    expect(sql).toContain("create policy ate_tasks_update");
    expect(sql).toContain("public.ate_is_member(workspace_id)");
    expect(sql).toContain("public.ate_assignee_is_member(workspace_id,assigned_to)");
  });
  it("only server-side functions may mint or join workspace invitations",()=>{
    expect(sql).toContain("create or replace function public.ate_create_invite");
    expect(sql).toContain("create or replace function public.ate_join_workspace");
    expect(sql).toContain("remaining_uses=remaining_uses-1");
    expect(sql).toContain("if v_count >= 5");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("revoke all on public.ate_workspace_invites from public,anon,authenticated");
  });
  it("never grants service-role powers to desktop clients",()=>{
    expect(sql).not.toContain("grant all on");
    expect(sql).toContain("grant select on public.ate_workspace_messages to authenticated");
  });
});
