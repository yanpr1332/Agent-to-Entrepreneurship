import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe,expect,it } from "vitest";

/**
 * These tests only review critical DDL controls. Real RLS access must also be
 * tested against an isolated Supabase project using independent user JWTs.
 */
const sql=readFileSync(join(process.cwd(),"supabase/migrations/20261110_ate_workspace_poc.sql"),"utf8");
const personalSql=readFileSync(join(process.cwd(),"supabase/migrations/20261124_ate_personal_sync.sql"),"utf8");

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

  it("enables owner-scoped RLS on all personal sync tables and grants no direct table access",()=>{
    for(const table of ["ate_personal_sync_accounts","ate_personal_sync_devices",
      "ate_personal_sync_records","ate_personal_sync_operations","ate_personal_sync_changes"]){
      expect(personalSql).toContain(`alter table public.${table} enable row level security;`);
      expect(personalSql).toContain(`create policy ${table}_read_own`);
    }
    expect(personalSql).toContain("using (owner_id = auth.uid())");
    expect(personalSql).toContain("revoke all on public.ate_personal_sync_records from public,anon,authenticated");
    expect(personalSql).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*on\s+public\.ate_personal_sync_(accounts|devices|records|operations|changes)/i);
  });

  it("restricts device registration, operation apply, pull and revocation to authenticated owner JWTs",()=>{
    for(const fn of ["ate_personal_sync_register_device","ate_personal_sync_apply",
      "ate_personal_sync_pull","ate_personal_sync_revoke_device"]){
      expect(personalSql).toContain(`create or replace function public.${fn}`);
      expect(personalSql).toContain(`revoke all on function public.${fn}`);
      expect(personalSql).toContain(`grant execute on function public.${fn}`);
    }
    expect(personalSql).toContain("security definer set search_path = ''");
    expect(personalSql).toContain("p_operation->>'ownerId'");
    expect(personalSql).toContain("p_operation->>'actorId'");
    expect(personalSql).toContain("revoked_at is null");
    expect(personalSql).toContain("operation_id");
    expect(personalSql).toContain("baseVersion");
  });

  it("uses per-owner serialized cursors, strict entity whitelists and durable idempotency receipts",()=>{
    expect(personalSql).toContain("for update");
    expect(personalSql).toContain("next_cursor=next_cursor+1");
    expect(personalSql).toContain("primary key (owner_id,operation_id)");
    expect(personalSql).toContain("primary key (owner_id,cursor)");
    expect(personalSql).toContain("'personal-task'");
    expect(personalSql).toContain("'manual-calendar-event'");
    expect(personalSql).not.toMatch(/service_role\s*[:=]/i);
    expect(personalSql).toContain("p_limit not between 1 and 500");
  });
});
