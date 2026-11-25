-- ALPHA-CLOSE-07: isolated Supabase test-project member revocation.
-- Review and deploy manually after workspace + durable-history/checkpoint migrations.
-- Does not delete messages/tasks; removes future access via member-scoped RLS.
-- Revoke all still-active invitations to prevent replay by a removed member.
create or replace function public.ate_revoke_workspace_member(
  p_workspace uuid,p_user uuid
) returns boolean language plpgsql volatile security definer set search_path = ''
as $$
begin
  if auth.uid() is null or p_workspace is null or p_user is null then
    raise exception 'Authenticated owner and valid workspace/member required';
  end if;
  -- Redemption obtains invitation row lock before workspace lock. Take locks
  -- in that same order to avoid a cross-transaction revoke/join deadlock.
  perform id from public.ate_workspace_invites
    where workspace_id=p_workspace order by id for update;
  -- Serialize this transaction with invitation redemption / five-person joins.
  perform 1 from public.ate_workspaces where id=p_workspace for update;
  if not found or not exists (
    select 1 from public.ate_workspace_members
    where workspace_id=p_workspace and user_id=auth.uid() and role='owner'
  ) then
    raise exception 'Only the workspace owner may revoke membership';
  end if;
  if p_user=auth.uid() or not exists (
    select 1 from public.ate_workspace_members
    where workspace_id=p_workspace and user_id=p_user and role='member'
  ) then
    raise exception 'Target must be a current non-owner member';
  end if;
  -- Preserve work, but never leave tasks assigned to an unauthorized member.
  -- Existing task history triggers record these updates for other members.
  update public.ate_workspace_tasks set assigned_to=null
    where workspace_id=p_workspace and assigned_to=p_user;
  delete from public.ate_workspace_members
    where workspace_id=p_workspace and user_id=p_user and role='member';
  -- Existing shared invite links must not silently re-enable revoked access.
  delete from public.ate_workspace_invites where workspace_id=p_workspace;
  return true;
end;
$$;
-- Re-issue invitations only under the workspace row lock; prevents a token
-- created concurrently with a revocation from surviving that revocation.
create or replace function public.ate_create_invite(p_workspace uuid)
returns text language plpgsql volatile security definer set search_path = ''
as $
declare v_token text;
begin
  if auth.uid() is null or p_workspace is null then
    raise exception 'Workspace owner required';
  end if;
  perform 1 from public.ate_workspaces where id=p_workspace for update;
  if not found or not exists (
    select 1 from public.ate_workspace_members
      where workspace_id=p_workspace and user_id=auth.uid() and role='owner'
  ) then
    raise exception 'Only an owner may invite members';
  end if;
  v_token := pg_catalog.encode(extensions.gen_random_bytes(24),'hex');
  insert into public.ate_workspace_invites(
    workspace_id,token_hash,issued_by,expires_at,remaining_uses
  ) values (
    p_workspace,pg_catalog.encode(extensions.digest(v_token,'sha256'),'hex'),
    auth.uid(),now()+interval '48 hours',4
  );
  return v_token;
end;
$;

revoke all on function public.ate_revoke_workspace_member(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.ate_revoke_workspace_member(uuid,uuid)
  to authenticated;
comment on function public.ate_revoke_workspace_member(uuid,uuid) is
  'Owner-only revocation with task unassignment and invalidation of all outstanding workspace invitations.';
