-- ALPHA-SYNC-002B: owner-scoped personal sync transport protocol.
-- Review and apply ONLY in an isolated, user-authorized Supabase test project.
-- The desktop uses the publishable/anon key plus the authenticated user's JWT.
-- No service_role key, direct table writes, team Workspace reuse, or auto-deployment.

create table if not exists public.ate_personal_sync_accounts (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  next_cursor bigint not null default 0 check (next_cursor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ate_personal_sync_devices (
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  device_label text not null check (char_length(device_label) between 1 and 60),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (owner_id,device_id)
);
create index if not exists ate_personal_sync_devices_owner
  on public.ate_personal_sync_devices(owner_id,last_seen_at desc);

create table if not exists public.ate_personal_sync_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('personal-task','manual-calendar-event')),
  entity_id uuid not null,
  version bigint not null check (version > 0),
  payload jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  device_id uuid not null,
  operation_id uuid not null,
  cursor bigint not null check (cursor > 0),
  primary key (owner_id,entity_type,entity_id),
  check ((deleted and payload is null) or (not deleted and payload is not null))
);

create table if not exists public.ate_personal_sync_operations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  request jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id,operation_id)
);

create table if not exists public.ate_personal_sync_changes (
  owner_id uuid not null references auth.users(id) on delete cascade,
  cursor bigint not null check (cursor > 0),
  entity_type text not null check (entity_type in ('personal-task','manual-calendar-event')),
  entity_id uuid not null,
  version bigint not null check (version > 0),
  payload jsonb,
  deleted boolean not null,
  updated_at timestamptz not null,
  operation_id uuid not null,
  primary key (owner_id,cursor),
  check ((deleted and payload is null) or (not deleted and payload is not null))
);

create index if not exists ate_personal_sync_changes_entity
  on public.ate_personal_sync_changes(owner_id,entity_type,entity_id,cursor);

alter table public.ate_personal_sync_accounts enable row level security;
alter table public.ate_personal_sync_devices enable row level security;
alter table public.ate_personal_sync_records enable row level security;
alter table public.ate_personal_sync_operations enable row level security;
alter table public.ate_personal_sync_changes enable row level security;

drop policy if exists ate_personal_sync_accounts_read_own on public.ate_personal_sync_accounts;
create policy ate_personal_sync_accounts_read_own on public.ate_personal_sync_accounts
  for select to authenticated using (owner_id = auth.uid());
drop policy if exists ate_personal_sync_devices_read_own on public.ate_personal_sync_devices;
create policy ate_personal_sync_devices_read_own on public.ate_personal_sync_devices
  for select to authenticated using (owner_id = auth.uid());
drop policy if exists ate_personal_sync_records_read_own on public.ate_personal_sync_records;
create policy ate_personal_sync_records_read_own on public.ate_personal_sync_records
  for select to authenticated using (owner_id = auth.uid());
drop policy if exists ate_personal_sync_operations_read_own on public.ate_personal_sync_operations;
create policy ate_personal_sync_operations_read_own on public.ate_personal_sync_operations
  for select to authenticated using (owner_id = auth.uid());
drop policy if exists ate_personal_sync_changes_read_own on public.ate_personal_sync_changes;
create policy ate_personal_sync_changes_read_own on public.ate_personal_sync_changes
  for select to authenticated using (owner_id = auth.uid());

-- The account row serializes cursor allocation for one owner across all devices.
-- This prevents a later transaction from committing a lower cursor after a
-- client has already advanced beyond it.
create or replace function public.ate_personal_sync_register_device(
  p_device_id uuid,
  p_device_label text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_created timestamptz;
  v_now timestamptz := now();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_device_id is null or p_device_label is null
     or char_length(btrim(p_device_label)) not between 1 and 60 then
    raise exception 'Invalid personal sync device';
  end if;

  insert into public.ate_personal_sync_accounts(owner_id)
    values(v_owner) on conflict(owner_id) do nothing;

  insert into public.ate_personal_sync_devices(owner_id,device_id,device_label)
    values(v_owner,p_device_id,btrim(p_device_label))
    on conflict(owner_id,device_id) do update
      set device_label=excluded.device_label,last_seen_at=v_now
      where public.ate_personal_sync_devices.revoked_at is null
    returning created_at into v_created;

  if not found then raise exception 'Personal sync device has been revoked'; end if;

  return jsonb_build_object(
    'ownerId',v_owner,
    'deviceId',p_device_id,
    'createdAt',to_char(v_created at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastSeenAt',to_char(v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.ate_personal_sync_apply(
  p_operation jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_actor uuid;
  v_declared_owner uuid;
  v_device uuid;
  v_operation_id uuid;
  v_entity_id uuid;
  v_entity_type text;
  v_action text;
  v_base_version bigint;
  v_client_timestamp timestamptz;
  v_payload jsonb;
  v_saved_request jsonb;
  v_saved_response jsonb;
  v_current_version bigint;
  v_current_payload jsonb;
  v_current_deleted boolean;
  v_current_cursor bigint;
  v_current_exists boolean := false;
  v_account_cursor bigint;
  v_new_cursor bigint;
  v_new_version bigint;
  v_response jsonb;
  v_title text;
  v_description text;
  v_due_date text;
  v_priority text;
  v_completed boolean;
  v_day text;
  v_start_minute integer;
  v_duration_minutes integer;
  v_series_id text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_operation is null or jsonb_typeof(p_operation) <> 'object'
     or jsonb_object_length(p_operation) <> 10
     or p_operation - array['operationId','deviceId','actorId','ownerId','entityId',
       'entityType','action','baseVersion','clientTimestamp','payload'] <> '{}'::jsonb then
    raise exception 'Invalid personal sync operation envelope';
  end if;

  v_actor := (p_operation->>'actorId')::uuid;
  v_declared_owner := (p_operation->>'ownerId')::uuid;
  if v_actor is distinct from v_owner or v_declared_owner is distinct from v_owner then
    raise exception 'Personal sync owner does not match authenticated user';
  end if;
  v_device := (p_operation->>'deviceId')::uuid;
  v_operation_id := (p_operation->>'operationId')::uuid;
  v_entity_id := (p_operation->>'entityId')::uuid;
  v_entity_type := p_operation->>'entityType';
  v_action := p_operation->>'action';
  v_client_timestamp := (p_operation->>'clientTimestamp')::timestamptz;
  if v_device is null or v_operation_id is null or v_entity_id is null
     or v_client_timestamp is null then
    raise exception 'Invalid personal sync operation identity';
  end if;
  if v_entity_type not in ('personal-task','manual-calendar-event')
     or v_entity_type is null or v_action is null
     or v_action not in ('upsert','delete') then
    raise exception 'Unsupported personal sync operation';
  end if;
  if jsonb_typeof(p_operation->'baseVersion') not in ('number','null') then
    raise exception 'Invalid personal sync base version';
  elsif jsonb_typeof(p_operation->'baseVersion')='null' then
    v_base_version := null;
  else
    v_base_version := (p_operation->>'baseVersion')::bigint;
    if v_base_version < 0 then raise exception 'Invalid personal sync base version'; end if;
  end if;

  select 1 into v_new_version from public.ate_personal_sync_devices
    where owner_id=v_owner and device_id=v_device and revoked_at is null
    for update;
  if not found then raise exception 'Personal sync device is not registered or has been revoked'; end if;

  if v_action='delete' then
    if jsonb_typeof(p_operation->'payload') <> 'null' or v_base_version is null then
      raise exception 'Delete requires a known version and null payload';
    end if;
  else
    v_payload := p_operation->'payload';
    if jsonb_typeof(v_payload) <> 'object' then raise exception 'Invalid personal sync payload'; end if;
    if v_entity_type='personal-task' then
      if jsonb_object_length(v_payload) <> 5
         or v_payload - array['title','description','dueDate','priority','completed'] <> '{}'::jsonb
         or jsonb_typeof(v_payload->'title') <> 'string'
         or jsonb_typeof(v_payload->'description') <> 'string'
         or jsonb_typeof(v_payload->'dueDate') not in ('string','null')
         or jsonb_typeof(v_payload->'priority') <> 'string'
         or jsonb_typeof(v_payload->'completed') <> 'boolean' then
        raise exception 'Invalid personal task payload';
      end if;
      v_title := v_payload->>'title';
      v_description := v_payload->>'description';
      v_due_date := v_payload->>'dueDate';
      v_priority := v_payload->>'priority';
      v_completed := (v_payload->>'completed')::boolean;
      if char_length(v_title) not between 1 and 120 or v_title <> btrim(v_title)
         or char_length(v_description) > 2000 or v_description <> btrim(v_description)
         or v_priority not in ('low','normal','high') then
        raise exception 'Personal task payload is outside allowed bounds';
      end if;
      if jsonb_typeof(v_payload->'dueDate')='string' then
        if v_due_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception 'Invalid personal task due date';
        end if;
        perform v_due_date::date;
      end if;
    else
      if jsonb_object_length(v_payload) <> 5
         or v_payload - array['title','day','startMinute','durationMinutes','seriesId'] <> '{}'::jsonb
         or jsonb_typeof(v_payload->'title') <> 'string'
         or jsonb_typeof(v_payload->'day') <> 'string'
         or jsonb_typeof(v_payload->'startMinute') <> 'number'
         or jsonb_typeof(v_payload->'durationMinutes') <> 'number'
         or jsonb_typeof(v_payload->'seriesId') not in ('string','null') then
        raise exception 'Invalid manual calendar payload';
      end if;
      v_title := v_payload->>'title';
      v_day := v_payload->>'day';
      v_start_minute := (v_payload->>'startMinute')::numeric;
      v_duration_minutes := (v_payload->>'durationMinutes')::numeric;
      v_series_id := v_payload->>'seriesId';
      if char_length(v_title) not between 1 and 120 or v_title <> btrim(v_title)
         or v_day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or trunc((v_payload->>'startMinute')::numeric) <> (v_payload->>'startMinute')::numeric
         or trunc((v_payload->>'durationMinutes')::numeric) <> (v_payload->>'durationMinutes')::numeric
         or v_start_minute not between 0 and 1439
         or v_duration_minutes not between 15 and 1440
         or v_start_minute+v_duration_minutes > 1440 then
        raise exception 'Manual calendar payload is outside allowed bounds';
      end if;
      perform v_day::date;
      if v_series_id is not null and v_series_id !~ '^manual:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12} then
        raise exception 'Only manual calendar series may sync';
      end if;
    end if;
  end if;

  insert into public.ate_personal_sync_accounts(owner_id)
    values(v_owner) on conflict(owner_id) do nothing;
  select next_cursor into v_account_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner for update;

  select request,response into v_saved_request,v_saved_response
    from public.ate_personal_sync_operations
    where owner_id=v_owner and operation_id=v_operation_id;
  if found then
    if v_saved_request=p_operation then return v_saved_response; end if;
    return jsonb_build_object('status','rejected','serverVersion',null,'cursor',null);
  end if;

  select version,payload,deleted,cursor into
    v_current_version,v_current_payload,v_current_deleted,v_current_cursor
    from public.ate_personal_sync_records
    where owner_id=v_owner and entity_type=v_entity_type and entity_id=v_entity_id
    for update;
  v_current_exists := found;

  if (not v_current_exists and v_base_version is not null)
     or (v_current_exists and v_base_version is distinct from v_current_version) then
    v_response := jsonb_build_object(
      'status','conflict',
      'serverVersion',v_current_version,
      'cursor',coalesce(v_current_cursor,v_account_cursor)::text
    );
    insert into public.ate_personal_sync_operations(owner_id,operation_id,request,response)
      values(v_owner,v_operation_id,p_operation,v_response);
    return v_response;
  end if;

  v_new_version := coalesce(v_current_version,0)+1;
  v_new_cursor := v_account_cursor+1;
  update public.ate_personal_sync_accounts
    set next_cursor=next_cursor+1,updated_at=now()
    where owner_id=v_owner;

  insert into public.ate_personal_sync_records(
    owner_id,entity_type,entity_id,version,payload,deleted,updated_at,device_id,operation_id,cursor
  ) values(
    v_owner,v_entity_type,v_entity_id,v_new_version,
    case when v_action='delete' then null else v_payload end,
    v_action='delete',now(),v_device,v_operation_id,v_new_cursor
  )
  on conflict(owner_id,entity_type,entity_id) do update set
    version=excluded.version,payload=excluded.payload,deleted=excluded.deleted,
    updated_at=excluded.updated_at,device_id=excluded.device_id,
    operation_id=excluded.operation_id,cursor=excluded.cursor;

  insert into public.ate_personal_sync_changes(
    owner_id,cursor,entity_type,entity_id,version,payload,deleted,updated_at,operation_id
  ) values(
    v_owner,v_new_cursor,v_entity_type,v_entity_id,v_new_version,
    case when v_action='delete' then null else v_payload end,
    v_action='delete',now(),v_operation_id
  );

  v_response := jsonb_build_object(
    'status','accepted','serverVersion',v_new_version,'cursor',v_new_cursor::text
  );
  insert into public.ate_personal_sync_operations(owner_id,operation_id,request,response)
    values(v_owner,v_operation_id,p_operation,v_response);
  return v_response;
end;
$$;

create or replace function public.ate_personal_sync_pull(
  p_device_id uuid,
  p_cursor text,
  p_limit integer default 200
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_cursor bigint;
  v_server_cursor bigint;
  v_changes jsonb;
  v_next_cursor bigint;
  v_has_more boolean;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_device_id is null or p_cursor is null
     or p_cursor !~ '^(0|[1-9][0-9]{0,18})
     or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid personal sync pull request';
  end if;
  v_cursor := p_cursor::bigint;

  if not exists(select 1 from public.ate_personal_sync_devices
      where owner_id=v_owner and device_id=p_device_id and revoked_at is null) then
    raise exception 'Personal sync device is not registered or has been revoked';
  end if;
  update public.ate_personal_sync_devices set last_seen_at=now()
    where owner_id=v_owner and device_id=p_device_id;

  select next_cursor into v_server_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner;
  if not found then raise exception 'Personal sync account is not registered'; end if;
  if v_cursor>v_server_cursor then raise exception 'Personal sync cursor is ahead of the server'; end if;

  with page as (
    select c.*,row_number() over(order by c.cursor) as rn
    from public.ate_personal_sync_changes c
    where c.owner_id=v_owner and c.cursor>v_cursor
    order by c.cursor
    limit p_limit+1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cursor',cursor::text,
      'entityType',entity_type,
      'entityId',entity_id,
      'version',version,
      'payload',payload,
      'deleted',deleted,
      'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) order by cursor) filter(where rn<=p_limit),'[]'::jsonb),
    coalesce(bool_or(rn>p_limit),false),
    coalesce(max(cursor) filter(where rn<=p_limit),v_cursor)
  into v_changes,v_has_more,v_next_cursor
  from page;

  return jsonb_build_object(
    'changes',v_changes,'nextCursor',v_next_cursor::text,'hasMore',v_has_more
  );
end;
$$;

create or replace function public.ate_personal_sync_revoke_device(
  p_device_id uuid
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_device_id is null then raise exception 'Invalid personal sync device'; end if;
  update public.ate_personal_sync_devices
    set revoked_at=coalesce(revoked_at,now()),last_seen_at=now()
    where owner_id=auth.uid() and device_id=p_device_id and revoked_at is null;
  return found;
end;
$$;

-- No direct PostgREST table access. All mutations and cursor reads go through
-- owner-checked SECURITY DEFINER RPCs; the user JWT remains the sole authority.
revoke all on public.ate_personal_sync_accounts from public,anon,authenticated;
revoke all on public.ate_personal_sync_devices from public,anon,authenticated;
revoke all on public.ate_personal_sync_records from public,anon,authenticated;
revoke all on public.ate_personal_sync_operations from public,anon,authenticated;
revoke all on public.ate_personal_sync_changes from public,anon,authenticated;

revoke all on function public.ate_personal_sync_register_device(uuid,text) from public,anon;
revoke all on function public.ate_personal_sync_apply(jsonb) from public,anon;
revoke all on function public.ate_personal_sync_pull(uuid,text,integer) from public,anon;
revoke all on function public.ate_personal_sync_revoke_device(uuid) from public,anon;
grant execute on function public.ate_personal_sync_register_device(uuid,text) to authenticated;
grant execute on function public.ate_personal_sync_apply(jsonb) to authenticated;
grant execute on function public.ate_personal_sync_pull(uuid,text,integer) to authenticated;
grant execute on function public.ate_personal_sync_revoke_device(uuid) to authenticated;

comment on table public.ate_personal_sync_records is
  'Owner-scoped latest personal task/manual calendar snapshots; writes only through validated RPCs.';
comment on table public.ate_personal_sync_changes is
  'Durable owner-scoped change log. Per-owner cursors are serialized by the account row.';
comment on table public.ate_personal_sync_operations is
  'Idempotency receipts. A repeated operation ID with a different request is rejected.';

     or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid personal sync pull request';
  end if;
  v_cursor := p_cursor::bigint;

  if not exists(select 1 from public.ate_personal_sync_devices
      where owner_id=v_owner and device_id=p_device_id and revoked_at is null) then
    raise exception 'Personal sync device is not registered or has been revoked';
  end if;
  update public.ate_personal_sync_devices set last_seen_at=now()
    where owner_id=v_owner and device_id=p_device_id;

  select next_cursor into v_server_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner;
  if not found then raise exception 'Personal sync account is not registered'; end if;
  if v_cursor>v_server_cursor then raise exception 'Personal sync cursor is ahead of the server'; end if;

  with page as (
    select c.*,row_number() over(order by c.cursor) as rn
    from public.ate_personal_sync_changes c
    where c.owner_id=v_owner and c.cursor>v_cursor
    order by c.cursor
    limit p_limit+1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cursor',cursor::text,
      'entityType',entity_type,
      'entityId',entity_id,
      'version',version,
      'payload',payload,
      'deleted',deleted,
      'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) order by cursor) filter(where rn<=p_limit),'[]'::jsonb),
    coalesce(bool_or(rn>p_limit),false),
    coalesce(max(cursor) filter(where rn<=p_limit),v_cursor)
  into v_changes,v_has_more,v_next_cursor
  from page;

  return jsonb_build_object(
    'changes',v_changes,'nextCursor',v_next_cursor::text,'hasMore',v_has_more
  );
end;
$$;

create or replace function public.ate_personal_sync_revoke_device(
  p_device_id uuid
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_device_id is null then raise exception 'Invalid personal sync device'; end if;
  update public.ate_personal_sync_devices
    set revoked_at=coalesce(revoked_at,now()),last_seen_at=now()
    where owner_id=auth.uid() and device_id=p_device_id and revoked_at is null;
  return found;
end;
$$;

-- No direct PostgREST table access. All mutations and cursor reads go through
-- owner-checked SECURITY DEFINER RPCs; the user JWT remains the sole authority.
revoke all on public.ate_personal_sync_accounts from public,anon,authenticated;
revoke all on public.ate_personal_sync_devices from public,anon,authenticated;
revoke all on public.ate_personal_sync_records from public,anon,authenticated;
revoke all on public.ate_personal_sync_operations from public,anon,authenticated;
revoke all on public.ate_personal_sync_changes from public,anon,authenticated;

revoke all on function public.ate_personal_sync_register_device(uuid,text) from public,anon;
revoke all on function public.ate_personal_sync_apply(jsonb) from public,anon;
revoke all on function public.ate_personal_sync_pull(uuid,text,integer) from public,anon;
revoke all on function public.ate_personal_sync_revoke_device(uuid) from public,anon;
grant execute on function public.ate_personal_sync_register_device(uuid,text) to authenticated;
grant execute on function public.ate_personal_sync_apply(jsonb) to authenticated;
grant execute on function public.ate_personal_sync_pull(uuid,text,integer) to authenticated;
grant execute on function public.ate_personal_sync_revoke_device(uuid) to authenticated;

comment on table public.ate_personal_sync_records is
  'Owner-scoped latest personal task/manual calendar snapshots; writes only through validated RPCs.';
comment on table public.ate_personal_sync_changes is
  'Durable owner-scoped change log. Per-owner cursors are serialized by the account row.';
comment on table public.ate_personal_sync_operations is
  'Idempotency receipts. A repeated operation ID with a different request is rejected.';
 then
        raise exception 'Only manual calendar series may sync';
      end if;
    end if;
  end if;

  insert into public.ate_personal_sync_accounts(owner_id)
    values(v_owner) on conflict(owner_id) do nothing;
  select next_cursor into v_account_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner for update;

  select request,response into v_saved_request,v_saved_response
    from public.ate_personal_sync_operations
    where owner_id=v_owner and operation_id=v_operation_id;
  if found then
    if v_saved_request=p_operation then return v_saved_response; end if;
    return jsonb_build_object('status','rejected','serverVersion',null,'cursor',null);
  end if;

  select version,payload,deleted,cursor into
    v_current_version,v_current_payload,v_current_deleted,v_current_cursor
    from public.ate_personal_sync_records
    where owner_id=v_owner and entity_type=v_entity_type and entity_id=v_entity_id
    for update;
  v_current_exists := found;

  if (not v_current_exists and v_base_version is not null)
     or (v_current_exists and v_base_version is distinct from v_current_version) then
    v_response := jsonb_build_object(
      'status','conflict',
      'serverVersion',v_current_version,
      'cursor',coalesce(v_current_cursor,v_account_cursor)::text
    );
    insert into public.ate_personal_sync_operations(owner_id,operation_id,request,response)
      values(v_owner,v_operation_id,p_operation,v_response);
    return v_response;
  end if;

  v_new_version := coalesce(v_current_version,0)+1;
  v_new_cursor := v_account_cursor+1;
  update public.ate_personal_sync_accounts
    set next_cursor=next_cursor+1,updated_at=now()
    where owner_id=v_owner;

  insert into public.ate_personal_sync_records(
    owner_id,entity_type,entity_id,version,payload,deleted,updated_at,device_id,operation_id,cursor
  ) values(
    v_owner,v_entity_type,v_entity_id,v_new_version,
    case when v_action='delete' then null else v_payload end,
    v_action='delete',now(),v_device,v_operation_id,v_new_cursor
  )
  on conflict(owner_id,entity_type,entity_id) do update set
    version=excluded.version,payload=excluded.payload,deleted=excluded.deleted,
    updated_at=excluded.updated_at,device_id=excluded.device_id,
    operation_id=excluded.operation_id,cursor=excluded.cursor;

  insert into public.ate_personal_sync_changes(
    owner_id,cursor,entity_type,entity_id,version,payload,deleted,updated_at,operation_id
  ) values(
    v_owner,v_new_cursor,v_entity_type,v_entity_id,v_new_version,
    case when v_action='delete' then null else v_payload end,
    v_action='delete',now(),v_operation_id
  );

  v_response := jsonb_build_object(
    'status','accepted','serverVersion',v_new_version,'cursor',v_new_cursor::text
  );
  insert into public.ate_personal_sync_operations(owner_id,operation_id,request,response)
    values(v_owner,v_operation_id,p_operation,v_response);
  return v_response;
end;
$$;

create or replace function public.ate_personal_sync_pull(
  p_device_id uuid,
  p_cursor text,
  p_limit integer default 200
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_cursor bigint;
  v_server_cursor bigint;
  v_changes jsonb;
  v_next_cursor bigint;
  v_has_more boolean;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_device_id is null or p_cursor is null
     or p_cursor !~ '^(0|[1-9][0-9]{0,18})
     or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid personal sync pull request';
  end if;
  v_cursor := p_cursor::bigint;

  if not exists(select 1 from public.ate_personal_sync_devices
      where owner_id=v_owner and device_id=p_device_id and revoked_at is null) then
    raise exception 'Personal sync device is not registered or has been revoked';
  end if;
  update public.ate_personal_sync_devices set last_seen_at=now()
    where owner_id=v_owner and device_id=p_device_id;

  select next_cursor into v_server_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner;
  if not found then raise exception 'Personal sync account is not registered'; end if;
  if v_cursor>v_server_cursor then raise exception 'Personal sync cursor is ahead of the server'; end if;

  with page as (
    select c.*,row_number() over(order by c.cursor) as rn
    from public.ate_personal_sync_changes c
    where c.owner_id=v_owner and c.cursor>v_cursor
    order by c.cursor
    limit p_limit+1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cursor',cursor::text,
      'entityType',entity_type,
      'entityId',entity_id,
      'version',version,
      'payload',payload,
      'deleted',deleted,
      'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) order by cursor) filter(where rn<=p_limit),'[]'::jsonb),
    coalesce(bool_or(rn>p_limit),false),
    coalesce(max(cursor) filter(where rn<=p_limit),v_cursor)
  into v_changes,v_has_more,v_next_cursor
  from page;

  return jsonb_build_object(
    'changes',v_changes,'nextCursor',v_next_cursor::text,'hasMore',v_has_more
  );
end;
$$;

create or replace function public.ate_personal_sync_revoke_device(
  p_device_id uuid
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_device_id is null then raise exception 'Invalid personal sync device'; end if;
  update public.ate_personal_sync_devices
    set revoked_at=coalesce(revoked_at,now()),last_seen_at=now()
    where owner_id=auth.uid() and device_id=p_device_id and revoked_at is null;
  return found;
end;
$$;

-- No direct PostgREST table access. All mutations and cursor reads go through
-- owner-checked SECURITY DEFINER RPCs; the user JWT remains the sole authority.
revoke all on public.ate_personal_sync_accounts from public,anon,authenticated;
revoke all on public.ate_personal_sync_devices from public,anon,authenticated;
revoke all on public.ate_personal_sync_records from public,anon,authenticated;
revoke all on public.ate_personal_sync_operations from public,anon,authenticated;
revoke all on public.ate_personal_sync_changes from public,anon,authenticated;

revoke all on function public.ate_personal_sync_register_device(uuid,text) from public,anon;
revoke all on function public.ate_personal_sync_apply(jsonb) from public,anon;
revoke all on function public.ate_personal_sync_pull(uuid,text,integer) from public,anon;
revoke all on function public.ate_personal_sync_revoke_device(uuid) from public,anon;
grant execute on function public.ate_personal_sync_register_device(uuid,text) to authenticated;
grant execute on function public.ate_personal_sync_apply(jsonb) to authenticated;
grant execute on function public.ate_personal_sync_pull(uuid,text,integer) to authenticated;
grant execute on function public.ate_personal_sync_revoke_device(uuid) to authenticated;

comment on table public.ate_personal_sync_records is
  'Owner-scoped latest personal task/manual calendar snapshots; writes only through validated RPCs.';
comment on table public.ate_personal_sync_changes is
  'Durable owner-scoped change log. Per-owner cursors are serialized by the account row.';
comment on table public.ate_personal_sync_operations is
  'Idempotency receipts. A repeated operation ID with a different request is rejected.';

     or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid personal sync pull request';
  end if;
  v_cursor := p_cursor::bigint;

  if not exists(select 1 from public.ate_personal_sync_devices
      where owner_id=v_owner and device_id=p_device_id and revoked_at is null) then
    raise exception 'Personal sync device is not registered or has been revoked';
  end if;
  update public.ate_personal_sync_devices set last_seen_at=now()
    where owner_id=v_owner and device_id=p_device_id;

  select next_cursor into v_server_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner;
  if not found then raise exception 'Personal sync account is not registered'; end if;
  if v_cursor>v_server_cursor then raise exception 'Personal sync cursor is ahead of the server'; end if;

  with page as (
    select c.*,row_number() over(order by c.cursor) as rn
    from public.ate_personal_sync_changes c
    where c.owner_id=v_owner and c.cursor>v_cursor
    order by c.cursor
    limit p_limit+1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cursor',cursor::text,
      'entityType',entity_type,
      'entityId',entity_id,
      'version',version,
      'payload',payload,
      'deleted',deleted,
      'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) order by cursor) filter(where rn<=p_limit),'[]'::jsonb),
    coalesce(bool_or(rn>p_limit),false),
    coalesce(max(cursor) filter(where rn<=p_limit),v_cursor)
  into v_changes,v_has_more,v_next_cursor
  from page;

  return jsonb_build_object(
    'changes',v_changes,'nextCursor',v_next_cursor::text,'hasMore',v_has_more
  );
end;
$$;

create or replace function public.ate_personal_sync_revoke_device(
  p_device_id uuid
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_device_id is null then raise exception 'Invalid personal sync device'; end if;
  update public.ate_personal_sync_devices
    set revoked_at=coalesce(revoked_at,now()),last_seen_at=now()
    where owner_id=auth.uid() and device_id=p_device_id and revoked_at is null;
  return found;
end;
$$;

-- No direct PostgREST table access. All mutations and cursor reads go through
-- owner-checked SECURITY DEFINER RPCs; the user JWT remains the sole authority.
revoke all on public.ate_personal_sync_accounts from public,anon,authenticated;
revoke all on public.ate_personal_sync_devices from public,anon,authenticated;
revoke all on public.ate_personal_sync_records from public,anon,authenticated;
revoke all on public.ate_personal_sync_operations from public,anon,authenticated;
revoke all on public.ate_personal_sync_changes from public,anon,authenticated;

revoke all on function public.ate_personal_sync_register_device(uuid,text) from public,anon;
revoke all on function public.ate_personal_sync_apply(jsonb) from public,anon;
revoke all on function public.ate_personal_sync_pull(uuid,text,integer) from public,anon;
revoke all on function public.ate_personal_sync_revoke_device(uuid) from public,anon;
grant execute on function public.ate_personal_sync_register_device(uuid,text) to authenticated;
grant execute on function public.ate_personal_sync_apply(jsonb) to authenticated;
grant execute on function public.ate_personal_sync_pull(uuid,text,integer) to authenticated;
grant execute on function public.ate_personal_sync_revoke_device(uuid) to authenticated;

comment on table public.ate_personal_sync_records is
  'Owner-scoped latest personal task/manual calendar snapshots; writes only through validated RPCs.';
comment on table public.ate_personal_sync_changes is
  'Durable owner-scoped change log. Per-owner cursors are serialized by the account row.';
comment on table public.ate_personal_sync_operations is
  'Idempotency receipts. A repeated operation ID with a different request is rejected.';
