import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe,expect,it} from "vitest";

const sql=readFileSync(join(process.cwd(),
  "supabase/migrations/20261125_ate_personal_file_sync.sql"),"utf8");

describe("V0.2 personal file migration static security checks (not live RLS proof)",()=>{
  it("has mandatory RLS, denies direct table access, and requires per-user authorization",()=>{
    expect(sql).toContain("alter table public.ate_personal_files enable row level security;");
    expect(sql).toContain("revoke all on public.ate_personal_files from public,anon,authenticated;");
    expect(sql).not.toMatch(/grant\s+(?:select|insert|update|delete|all)\s+on\s+public\.ate_personal_files\s+to\s+(?:public|anon|authenticated)/i);
    for(const name of ["ate_file_list","ate_file_get","ate_file_apply"])
      expect(sql).toContain("public."+name);
    expect(sql.match(/security definer set search_path = ''/g)).toHaveLength(3);
    expect(sql).toContain("auth.uid()");
  });
  it("uses atomic version checks, byte limit and server-side SHA256 verification",()=>{
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("for update");
    expect(sql).toContain("v_row.version<>p_base_version");
    expect(sql).toContain("digest(v_bytes,'sha256')");
    expect(sql).toContain("p_byte_length>1048576");
    expect(sql).toContain(")>=20");
  });
  it("clears bytes on tombstone and never grants anonymous RPC access",()=>{
    expect(sql).toContain("deleted=true,content=null,sha256=null");
    expect(sql).toContain("byte_length=0,version=version+1");
    expect(sql).toContain("grant execute on function public.ate_file_get(uuid) to authenticated");
    expect(sql).toContain("from public,anon,authenticated;");
  });
});
