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
revoke all on function public.ate_revoke_workspace_member(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.ate_revoke_workspace_member(uuid,uuid)
  to authenticated;
comment on function public.ate_revoke_workspace_member(uuid,uuid) is
  'Owner-only revocation with task unassignment and invalidation of all outstanding workspace invitations.';
