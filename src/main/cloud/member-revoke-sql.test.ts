import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const sql=readFileSync(resolve(process.cwd(),
  "supabase/migrations/20261125_ate_workspace_member_revoke.sql"),"utf8");

describe("ALPHA-CLOSE-07 owner-only member revoke SQL",()=>{
  it("uses definer-scoped JWT authorization without exposing an anon RPC",()=>{
    expect(sql).toMatch(/ate_revoke_workspace_member\s*\(\s*p_workspace\s+uuid\s*,\s*p_user\s+uuid/);
    expect(sql).toMatch(/auth\.uid\(\)/);
    expect(sql).toMatch(/role\s*=\s*'owner'/);
    expect(sql).toMatch(/role\s*=\s*'member'/);
    expect(sql).toMatch(/revoke all on function public\.ate_revoke_workspace_member\(uuid,uuid\)[\s\S]*?from public,anon,authenticated/);
    expect(sql).toMatch(/grant execute on function public\.ate_revoke_workspace_member\(uuid,uuid\)[\s\S]*?to authenticated/);
    expect(sql).not.toMatch(/grant\s+(all|execute)\s+on\s+function[^;]+to anon/i);
  });
  it("clears task assignments and prior invites without deleting work",()=>{
    expect(sql).toMatch(/update public\.ate_workspace_tasks set assigned_to=null/);
    expect(sql).toMatch(/delete from public\.ate_workspace_members/);
    expect(sql).toMatch(/delete from public\.ate_workspace_invites/);
    expect(sql).not.toMatch(/delete from public\.ate_workspace_messages/);
    expect(sql).not.toMatch(/delete from public\.ate_workspace_tasks/);
  });
  it("serializes invitations and revocation at workspace row boundary",()=>{
    expect(sql).toMatch(/perform id from public\.ate_workspace_invites[\s\S]+for update/);
    expect(sql).toMatch(/perform 1 from public\.ate_workspaces where id=p_workspace for update/);
    expect(sql).toMatch(/create or replace function public\.ate_create_invite/);
  });
});
