-- ALPHA-SYNC-003C: explicitly controlled, owner-only team-journal compaction.
-- Requires 20261124_ate_workspace_durable_history.sql and all workspace RLS.
-- This migration only installs schema/RPCs. It does NOT compact automatically.
-- Execute in a user-authorized isolated Supabase project, never via CI.
begin;

alter table public.ate_workspace_history_state
  add column if not exists min_cursor bigint not null default 0;
alter table public.ate_workspace_history_state
  add column if not exists checkpoint_cursor bigint;
alter table public.ate_workspace_history_state
  add column if not exists checkpoint_count bigint not null default 0;
alter table public.ate_workspace_history_state
  drop constraint if exists ate_workspace_history_min_cursor_check;
alter table public.ate_workspace_history_state
  add constraint ate_workspace_history_min_cursor_check
  check (min_cursor>=0 and min_cursor<=last_cursor
    and checkpoint_count>=0
    and (checkpoint_cursor is null or
         (checkpoint_cursor=min_cursor and checkpoint_cursor>0)));

-- Immutable, version-pinned baseline for a single generation at a time.
-- The old baseline may be removed when a NEW one is committed. Clients MUST
-- abandon a displaced staging generation and restart, never publish partials.
create table if not exists public.ate_workspace_history_checkpoint (
  workspace_id uuid not null references public.ate_workspaces(id) on delete cascade,
  checkpoint_cursor bigint not null check(checkpoint_cursor>0),
  ordinal bigint not null check(ordinal>0),
  kind text not null check(kind in ('message','task')),
  entity_id uuid not null,
  entity_payload jsonb not null check(jsonb_typeof(entity_payload)='object'),
  primary key(workspace_id,checkpoint_cursor,ordinal),
  unique(workspace_id,checkpoint_cursor,kind,entity_id)
);
alter table public.ate_workspace_history_checkpoint enable row level security;
revoke all on public.ate_workspace_history_checkpoint from public,anon,authenticated;

-- Replaces only the pull RPC with an explicit, versioned cursor-expiry result.
-- Live pages preserve the ALPHA-SYNC-003B response shape for older clients.
create or replace function public.ate_workspace_history_pull(
  p_workspace_id uuid,p_after bigint,p_limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_cursor bigint;
  v_min bigint;
  v_checkpoint bigint;
  v_count bigint;
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
  select last_cursor,min_cursor,checkpoint_cursor,checkpoint_count
    into v_cursor,v_min,v_checkpoint,v_count
    from public.ate_workspace_history_state where workspace_id=p_workspace_id;
  v_cursor:=coalesce(v_cursor,0);
  v_min:=coalesce(v_min,0);
  if p_after>v_cursor then
    raise exception 'Workspace history cursor ahead of server';
  end if;
  if p_after<v_min then
    if v_checkpoint is null or v_checkpoint<>v_min then
      raise exception 'Missing trusted team history checkpoint';
    end if;
    return jsonb_build_object(
      'status','expired','checkpointCursor',v_checkpoint::text,
      'serverCursor',v_cursor::text,'totalItems',v_count::text
    );
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

-- All pages refer to one immutable checkpoint cursor. A replaced checkpoint
-- MUST fail rather than returning mixed rows from different generations.
create or replace function public.ate_workspace_history_snapshot(
  p_workspace_id uuid,p_checkpoint_cursor bigint,
  p_after bigint default 0,p_limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_count bigint;
  v_next bigint;
  v_rows jsonb;
begin
  if auth.uid() is null or p_workspace_id is null or
     not public.ate_is_member(p_workspace_id) then
    raise exception 'Workspace membership required';
  end if;
  if p_checkpoint_cursor is null or p_checkpoint_cursor<1 or
     p_after is null or p_after<0 or
     p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'Invalid workspace snapshot page';
  end if;
  select checkpoint_count into v_count
  from public.ate_workspace_history_state
  where workspace_id=p_workspace_id and
    checkpoint_cursor=p_checkpoint_cursor;
  if not found then
    raise exception 'Workspace checkpoint generation replaced; restart from newest';
  end if;
  if p_after>v_count then
    raise exception 'Workspace checkpoint ordinal ahead of snapshot';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'ordinal',h.ordinal::text,'kind',h.kind,
    'entityId',h.entity_id::text,'record',h.entity_payload
  ) order by h.ordinal),'[]'::jsonb),coalesce(max(h.ordinal),p_after)
    into v_rows,v_next
  from (
    select ordinal,kind,entity_id,entity_payload
    from public.ate_workspace_history_checkpoint
    where workspace_id=p_workspace_id
      and checkpoint_cursor=p_checkpoint_cursor
      and ordinal>p_after order by ordinal asc limit p_limit
  ) h;
  return jsonb_build_object(
    'checkpointCursor',p_checkpoint_cursor::text,
    'totalItems',v_count::text,
    'items',v_rows,'nextOrdinal',v_next::text,
    'hasMore',v_next<v_count
  );
end;
$$;

-- Deliberate, owner-only operation. No automatic retention policy here.
-- Lock table writers BEFORE reading the counter: existing DML locks team
-- tables then trigger-locks state. This order avoids deadlocks and ensures
-- the baseline is exactly the state after all earlier committed writes.
create or replace function public.ate_workspace_history_compact(
  p_workspace_id uuid
) returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare
  v_cursor bigint;
  v_min bigint;
  v_count bigint;
begin
  if auth.uid() is null or p_workspace_id is null or not exists(
    select 1 from public.ate_workspace_members
      where workspace_id=p_workspace_id
        and user_id=auth.uid() and role='owner'
  ) then
    raise exception 'Workspace owner required for history checkpoint';
  end if;
  lock table public.ate_workspace_messages,public.ate_workspace_tasks
    in share row exclusive mode;
  -- Locks this workspace's counter row for the rest of the transaction.
  insert into public.ate_workspace_history_state(workspace_id,last_cursor)
    values(p_workspace_id,0) on conflict(workspace_id) do nothing;
  select last_cursor,min_cursor into v_cursor,v_min
    from public.ate_workspace_history_state
    where workspace_id=p_workspace_id for update;
  if v_cursor<=v_min then
    return jsonb_build_object('status','unchanged','cursor',v_cursor::text);
  end if;

  insert into public.ate_workspace_history_checkpoint(
    workspace_id,checkpoint_cursor,ordinal,kind,entity_id,entity_payload
  )
  select p_workspace_id,v_cursor,
    row_number() over(order by source.kind,source.entity_id),
    source.kind,source.entity_id,source.payload
  from (
    select 'message'::text as kind,m.id as entity_id,to_jsonb(m) as payload
      from public.ate_workspace_messages m where m.workspace_id=p_workspace_id
    union all
    select 'task'::text as kind,t.id as entity_id,to_jsonb(t) as payload
      from public.ate_workspace_tasks t where t.workspace_id=p_workspace_id
  ) source;
  get diagnostics v_count=row_count;
  update public.ate_workspace_history_state
    set min_cursor=v_cursor,checkpoint_cursor=v_cursor,
      checkpoint_count=v_count where workspace_id=p_workspace_id;

  -- Drop older, superseded snapshots atomically with min_cursor advance.
  delete from public.ate_workspace_history_checkpoint
    where workspace_id=p_workspace_id and checkpoint_cursor<>v_cursor;
  delete from public.ate_workspace_history
    where workspace_id=p_workspace_id and cursor<=v_cursor;
  return jsonb_build_object(
    'status','compacted','checkpointCursor',v_cursor::text,
    'totalItems',v_count::text
  );
end;
$$;

-- SECURITY DEFINER functions don't expose raw rows through arbitrary table
-- grants. No service-role JWT is ever shipped to Electron.
revoke all on function public.ate_workspace_history_pull(uuid,bigint,integer)
  from public,anon,authenticated;
grant execute on function public.ate_workspace_history_pull(uuid,bigint,integer)
  to authenticated;
revoke all on function public.ate_workspace_history_snapshot(uuid,bigint,bigint,integer)
  from public,anon,authenticated;
grant execute on function public.ate_workspace_history_snapshot(uuid,bigint,bigint,integer)
  to authenticated;
revoke all on function public.ate_workspace_history_compact(uuid)
  from public,anon,authenticated;
grant execute on function public.ate_workspace_history_compact(uuid)
  to authenticated;
commit;
