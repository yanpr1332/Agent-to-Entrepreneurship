-- ALPHA-SYNC-003B (optional): durable, per-workspace, commit-ordered team journal.
-- Requires 20261110_ate_workspace_poc.sql; deploy only in an approved isolated
-- test project. Review plaintext payload retention/storage before deployment.
-- Never run via CI; no service_role key is shipped to desktop.
--
-- The per-workspace counter row is locked until COMMIT. Concurrent writers in
-- the SAME workspace therefore cannot commit in a different cursor order.
-- PostgreSQL sequence IDs alone would NOT offer this safety.
begin;

create table if not exists public.ate_workspace_history_state (
  workspace_id uuid primary key references public.ate_workspaces(id) on delete cascade,
  last_cursor bigint not null default 0 check(last_cursor >= 0)
);

create table if not exists public.ate_workspace_history (
  workspace_id uuid not null references public.ate_workspaces(id) on delete cascade,
  cursor bigint not null check(cursor > 0),
  kind text not null check(kind in ('message','task')),
  action text not null check(action in ('upsert','delete')),
  entity_id uuid not null,
  entity_payload jsonb,
  created_at timestamptz not null default now(),
  primary key(workspace_id,cursor),
  check((action='delete' and entity_payload is null) or
        (action='upsert' and jsonb_typeof(entity_payload)='object'))
);
create index if not exists ate_workspace_history_entity
  on public.ate_workspace_history(workspace_id,kind,entity_id,cursor desc);

alter table public.ate_workspace_history enable row level security;
alter table public.ate_workspace_history_state enable row level security;

-- No direct public/anon/authenticated writes. Use one owner-authenticated
-- SECURITY DEFINER RPC to read cursor-bounded pages, not raw tables.
revoke all on public.ate_workspace_history from public,anon,authenticated;
revoke all on public.ate_workspace_history_state from public,anon,authenticated;

-- Block concurrent team writes during backfill/trigger installation. This
-- migration commits atomically so existing records cannot be missed.
lock table public.ate_workspace_messages, public.ate_workspace_tasks
  in share row exclusive mode;

-- Backfill both tables exactly once on first deployment; repeat migration
-- cannot replay all historical rows. Existing open workspaces without rows
-- get a zero-state entry and can record new events normally afterward.
do $$
declare
  v_workspace uuid;
  v_kind text;
  v_id uuid;
  v_payload jsonb;
  v_cursor bigint;
begin
  for v_workspace in select id from public.ate_workspaces order by id loop
    if exists(select 1 from public.ate_workspace_history
              where workspace_id=v_workspace limit 1) then
      continue;
    end if;
    for v_kind,v_id,v_payload in
      select event.kind,event.id,event.data
        from (
          select 'message'::text as kind,id,created_at,to_jsonb(m) as data
          from public.ate_workspace_messages m where workspace_id=v_workspace
          union all
          select 'task'::text as kind,id,created_at,to_jsonb(t) as data
          from public.ate_workspace_tasks t where workspace_id=v_workspace
        ) event
       order by event.created_at,event.id,event.kind
    loop
      insert into public.ate_workspace_history_state(workspace_id,last_cursor)
        values(v_workspace,1)
        on conflict(workspace_id)
        do update set last_cursor=public.ate_workspace_history_state.last_cursor+1
        returning last_cursor into v_cursor;
      insert into public.ate_workspace_history
        (workspace_id,cursor,kind,action,entity_id,entity_payload)
        values(v_workspace,v_cursor,v_kind,'upsert',v_id,v_payload);
    end loop;
  end loop;
end;
$$;

create or replace function public.ate_record_workspace_history()
returns trigger language plpgsql security definer set search_path=''
as $$
declare
  v_workspace uuid;
  v_cursor bigint;
  v_kind text;
  v_action text;
  v_id uuid;
  v_payload jsonb;
begin
  v_workspace := case when TG_OP='DELETE' then old.workspace_id else new.workspace_id end;
  v_id := case when TG_OP='DELETE' then old.id else new.id end;
  v_kind := case when TG_TABLE_NAME='ate_workspace_messages' then 'message' else 'task' end;
  v_action := case when TG_OP='DELETE' then 'delete' else 'upsert' end;
  v_payload := case when TG_OP='DELETE' then null else to_jsonb(new) end;
  insert into public.ate_workspace_history_state(workspace_id,last_cursor)
    values(v_workspace,1)
    on conflict(workspace_id)
    do update set last_cursor=public.ate_workspace_history_state.last_cursor+1
    returning last_cursor into v_cursor;
  insert into public.ate_workspace_history
    (workspace_id,cursor,kind,action,entity_id,entity_payload)
    values(v_workspace,v_cursor,v_kind,v_action,v_id,v_payload);
  return case when TG_OP='DELETE' then old else new end;
end;
$$;

drop trigger if exists ate_messages_history on public.ate_workspace_messages;
create trigger ate_messages_history
  after insert or update or delete on public.ate_workspace_messages
  for each row execute function public.ate_record_workspace_history();
drop trigger if exists ate_tasks_history on public.ate_workspace_tasks;
create trigger ate_tasks_history
  after insert or update or delete on public.ate_workspace_tasks
  for each row execute function public.ate_record_workspace_history();

create or replace function public.ate_workspace_history_pull(
  p_workspace_id uuid,p_after bigint,p_limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_cursor bigint;
  v_next bigint;
  v_changes jsonb;
  v_more boolean;
begin
  if auth.uid() is null or p_workspace_id is null or
     not public.ate_is_member(p_workspace_id) then
    raise exception 'Workspace membership required';
  end if;
  if p_after is null or p_after < 0 or
     p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid workspace history page';
  end if;
  select last_cursor into v_cursor from public.ate_workspace_history_state
    where workspace_id=p_workspace_id;
  v_cursor := coalesce(v_cursor,0);
  if p_after > v_cursor then
    raise exception 'Workspace history cursor ahead of server';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'cursor',h.cursor::text,'kind',h.kind,'action',h.action,
      'entityId',h.entity_id::text,'record',h.entity_payload
    ) order by h.cursor),'[]'::jsonb),coalesce(max(h.cursor),p_after)
    into v_changes,v_next
  from (
    select cursor,kind,action,entity_id,entity_payload
    from public.ate_workspace_history
    where workspace_id=p_workspace_id and cursor>p_after and cursor<=v_cursor
    order by cursor asc limit p_limit
  ) h;

  select exists(
    select 1 from public.ate_workspace_history
    where workspace_id=p_workspace_id and cursor>v_next and cursor<=v_cursor
  ) into v_more;
  return jsonb_build_object(
    'changes',v_changes,'nextCursor',v_next::text,
    'serverCursor',v_cursor::text,'hasMore',v_more
  );
end;
$$;

revoke all on function public.ate_record_workspace_history()
  from public,anon,authenticated;
revoke all on function public.ate_workspace_history_pull(uuid,bigint,integer)
  from public,anon;
grant execute on function public.ate_workspace_history_pull(uuid,bigint,integer)
  to authenticated;

comment on function public.ate_workspace_history_pull(uuid,bigint,integer) is
  'Auth-member-only per-workspace commit-ordered immutable change page. Client must stage each page atomically.';

commit;
