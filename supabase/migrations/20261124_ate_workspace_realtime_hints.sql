-- ALPHA-SYNC-003A: optional, test-project-only Realtime publication.
-- REQUIRED BEFORE this: 20261110_ate_workspace_poc.sql, its RLS and grants.
-- Never execute in CI, production, or any project without owner approval.
-- RLS is authoritative; the client never uses a service-role JWT.
-- Replicate messages and tasks ONLY; never invitations, credentials, or personal data.
do $$
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    raise exception 'Supabase Realtime publication is missing; do not create a broad publication';
  end if;
  if not exists(
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public'
      and tablename='ate_workspace_messages'
  ) then
    alter publication supabase_realtime add table public.ate_workspace_messages;
  end if;
  if not exists(
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public'
      and tablename='ate_workspace_tasks'
  ) then
    alter publication supabase_realtime add table public.ate_workspace_tasks;
  end if;
end $$;

-- No REPLICA IDENTITY FULL, no new permissive policy, no service-role access.
-- Realtime is merely a hint: clients always fetch under the normal PostgREST RLS
-- and periodically reconcile even when websocket reports healthy.
