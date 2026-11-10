-- Supabase/Postgres candidate proof of concept.
-- Execute only in a user-owned test project after reviewing this migration.
-- Auth users are individual: never embed service_role in the desktop app.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ate_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.ate_workspace_members (
  workspace_id uuid not null references public.ate_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','member')),
  display_name text not null check (char_length(display_name) between 1 and 60),
  joined_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);
create index if not exists ate_members_user on public.ate_workspace_members (user_id);

create table if not exists public.ate_workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ate_workspaces(id) on delete cascade,
  token_hash text not null unique,
  issued_by uuid not null references auth.users(id),
  expires_at timestamptz not null,
  remaining_uses int not null check (remaining_uses between 0 and 4),
  created_at timestamptz not null default now()
);
create index if not exists ate_invites_workspace on public.ate_workspace_invites(workspace_id);

create table if not exists public.ate_workspace_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ate_workspaces(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists ate_messages_workspace_time
  on public.ate_workspace_messages (workspace_id,created_at desc);

create table if not exists public.ate_workspace_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ate_workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text not null check (char_length(title) between 1 and 120),
  due_date date,
  assigned_to uuid references auth.users(id),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ate_tasks_workspace on public.ate_workspace_tasks (workspace_id,due_date);

-- SECURITY DEFINER avoids recursive RLS when membership policies inspect membership.
-- Membership is always checked against auth.uid(), never an untrusted parameter.
create or replace function public.ate_is_member(p_workspace uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(
    select 1 from public.ate_workspace_members m
    where m.workspace_id = p_workspace and m.user_id = auth.uid()
  );
$$;

create or replace function public.ate_assignee_is_member(p_workspace uuid, p_assignee uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(
    select 1 from public.ate_workspace_members m
    where m.workspace_id = p_workspace and m.user_id = p_assignee
  );
$$;

alter table public.ate_workspaces enable row level security;
alter table public.ate_workspace_members enable row level security;
alter table public.ate_workspace_invites enable row level security;
alter table public.ate_workspace_messages enable row level security;
alter table public.ate_workspace_tasks enable row level security;

-- Idempotent policy creation for repeatable test-project migrations.
drop policy if exists ate_workspaces_read on public.ate_workspaces;
create policy ate_workspaces_read on public.ate_workspaces for select to authenticated
  using (public.ate_is_member(id));
drop policy if exists ate_members_read on public.ate_workspace_members;
create policy ate_members_read on public.ate_workspace_members for select to authenticated
  using (public.ate_is_member(workspace_id));
drop policy if exists ate_messages_read on public.ate_workspace_messages;
create policy ate_messages_read on public.ate_workspace_messages for select to authenticated
  using (public.ate_is_member(workspace_id));
drop policy if exists ate_messages_insert on public.ate_workspace_messages;
create policy ate_messages_insert on public.ate_workspace_messages for insert to authenticated
  with check (author_id = auth.uid() and public.ate_is_member(workspace_id));
drop policy if exists ate_tasks_read on public.ate_workspace_tasks;
create policy ate_tasks_read on public.ate_workspace_tasks for select to authenticated
  using (public.ate_is_member(workspace_id));
drop policy if exists ate_tasks_insert on public.ate_workspace_tasks;
create policy ate_tasks_insert on public.ate_workspace_tasks for insert to authenticated
  with check (
    created_by = auth.uid() and public.ate_is_member(workspace_id)
    and (assigned_to is null or public.ate_assignee_is_member(workspace_id,assigned_to))
  );
drop policy if exists ate_tasks_update on public.ate_workspace_tasks;
create policy ate_tasks_update on public.ate_workspace_tasks for update to authenticated
  using (public.ate_is_member(workspace_id))
  with check (
    public.ate_is_member(workspace_id)
    and (assigned_to is null or public.ate_assignee_is_member(workspace_id,assigned_to))
  );

-- No SELECT/INSERT/UPDATE/DELETE RLS policy for invites; only vetted functions access them.
-- No direct INSERT policies for workspaces or memberships: RPC creates them atomically.
create or replace function public.ate_create_workspace(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(p_name)) not between 1 and 120
     or char_length(trim(p_display_name)) not between 1 and 60 then
    raise exception 'Invalid workspace or display name';
  end if;
  insert into public.ate_workspaces(name,created_by) values(trim(p_name),auth.uid())
    returning id into v_id;
  insert into public.ate_workspace_members(workspace_id,user_id,role,display_name)
    values(v_id,auth.uid(),'owner',trim(p_display_name));
  return v_id;
end;
$$;

create or replace function public.ate_create_invite(p_workspace uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_token text;
begin
  if auth.uid() is null or not exists(
    select 1 from public.ate_workspace_members
    where workspace_id=p_workspace and user_id=auth.uid() and role='owner'
  ) then raise exception 'Only an owner may invite members'; end if;
  -- 192 bits of CSPRNG entropy; token plaintext is returned once, not stored.
  v_token := pg_catalog.encode(extensions.gen_random_bytes(24),'hex');
  insert into public.ate_workspace_invites(
    workspace_id,token_hash,issued_by,expires_at,remaining_uses
  ) values(
    p_workspace,
    pg_catalog.encode(extensions.digest(v_token,'sha256'),'hex'),
    auth.uid(),now()+interval '48 hours',4
  );
  return v_token;
end;
$$;

create or replace function public.ate_join_workspace(p_token text, p_display_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_invite public.ate_workspace_invites%rowtype;
declare v_count int;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{48}$'
     or char_length(trim(p_display_name)) not between 1 and 60 then
    raise exception 'Invalid invitation or display name';
  end if;
  select * into v_invite from public.ate_workspace_invites
    where token_hash=pg_catalog.encode(extensions.digest(p_token,'sha256'),'hex')
    for update;
  if not found or v_invite.expires_at <= now() or v_invite.remaining_uses < 1 then
    raise exception 'Invitation expired or invalid';
  end if;
  -- Workspace row lock serializes all invite joins for the five-person limit.
  perform 1 from public.ate_workspaces where id=v_invite.workspace_id for update;
  if exists(select 1 from public.ate_workspace_members
      where workspace_id=v_invite.workspace_id and user_id=auth.uid()) then
    return v_invite.workspace_id;
  end if;
  select count(*) into v_count from public.ate_workspace_members
    where workspace_id=v_invite.workspace_id;
  if v_count >= 5 then raise exception 'Workspace member limit reached'; end if;
  insert into public.ate_workspace_members(workspace_id,user_id,role,display_name)
    values(v_invite.workspace_id,auth.uid(),'member',trim(p_display_name));
  update public.ate_workspace_invites
    set remaining_uses=remaining_uses-1 where id=v_invite.id;
  return v_invite.workspace_id;
end;
$$;

-- Constrain task updates even if a client tries to supply immutable columns.
create or replace function public.ate_guard_task_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Cannot reassign task ownership or workspace';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists ate_guard_task on public.ate_workspace_tasks;
create trigger ate_guard_task before update on public.ate_workspace_tasks
  for each row execute function public.ate_guard_task_update();

-- Explicit grants: the desktop uses ONLY the publishable/anon key plus user JWT.
revoke all on public.ate_workspaces from public,anon,authenticated;
revoke all on public.ate_workspace_members from public,anon,authenticated;
revoke all on public.ate_workspace_invites from public,anon,authenticated;
revoke all on public.ate_workspace_messages from public,anon,authenticated;
revoke all on public.ate_workspace_tasks from public,anon,authenticated;
grant select on public.ate_workspaces to authenticated;
grant select on public.ate_workspace_members to authenticated;
grant select on public.ate_workspace_messages to authenticated;
grant insert(workspace_id,author_id,body) on public.ate_workspace_messages to authenticated;
grant select on public.ate_workspace_tasks to authenticated;
grant insert(workspace_id,created_by,title,due_date,assigned_to,completed)
  on public.ate_workspace_tasks to authenticated;
grant update(title,due_date,assigned_to,completed)
  on public.ate_workspace_tasks to authenticated;

revoke all on function public.ate_is_member(uuid) from public,anon;
revoke all on function public.ate_assignee_is_member(uuid,uuid) from public,anon;
revoke all on function public.ate_create_workspace(text,text) from public,anon;
revoke all on function public.ate_create_invite(uuid) from public,anon;
revoke all on function public.ate_join_workspace(text,text) from public,anon;
grant execute on function public.ate_is_member(uuid) to authenticated;
grant execute on function public.ate_assignee_is_member(uuid,uuid) to authenticated;
grant execute on function public.ate_create_workspace(text,text) to authenticated;
grant execute on function public.ate_create_invite(uuid) to authenticated;
grant execute on function public.ate_join_workspace(text,text) to authenticated;
