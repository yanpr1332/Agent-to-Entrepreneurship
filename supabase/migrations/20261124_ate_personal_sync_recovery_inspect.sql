-- ALPHA-SYNC-002H: owner-authenticated, READ-ONLY diagnosis and exact-operation receipt lookup.
-- Apply ONLY to an isolated Supabase test project after the 002B baseline migration
-- and explicit approval. Never deploy from CI, and never include service-role keys.
-- These functions have no writes and reveal no task/calendar payloads.
create or replace function public.ate_personal_sync_inspect_device(
  p_device_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_cursor bigint := 0;
  v_revoked timestamptz;
  v_found boolean := false;
  v_status text := 'unregistered';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_device_id is null then raise exception 'Invalid personal sync device'; end if;

  select coalesce(next_cursor,0) into v_cursor
    from public.ate_personal_sync_accounts where owner_id=v_owner;
  if not found then v_cursor := 0; end if;

  select revoked_at into v_revoked
    from public.ate_personal_sync_devices
    where owner_id=v_owner and device_id=p_device_id;
  v_found := found;
  if v_found then
    v_status := case when v_revoked is null then 'active' else 'revoked' end;
  end if;
  return jsonb_build_object('deviceStatus',v_status,'serverCursor',v_cursor::text);
end;
$$;

-- A crashed client can examine ONLY its own exact persisted operation envelope.
-- There is no remote payload in the response. A mismatched operationId is never
-- considered acknowledged; do not guess success from a matching entityId.
-- The device need not still be active: its old receipt remains owner-scoped.
create or replace function public.ate_personal_sync_lookup_receipt(
  p_operation jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_op_id uuid;
  v_saved_request jsonb;
  v_saved_response jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_operation is null or jsonb_typeof(p_operation) <> 'object'
     or p_operation->>'ownerId' is distinct from v_owner::text
     or p_operation->>'actorId' is distinct from v_owner::text
     or p_operation->>'operationId' is null
     or p_operation->>'deviceId' is null then
    raise exception 'Invalid owner-scoped operation receipt request';
  end if;
  v_op_id := (p_operation->>'operationId')::uuid;
  select request,response into v_saved_request,v_saved_response
    from public.ate_personal_sync_operations
    where owner_id=v_owner and operation_id=v_op_id;
  if not found then
    return jsonb_build_object('status','not-found','response',null);
  end if;
  if v_saved_request is distinct from p_operation then
    return jsonb_build_object('status','mismatch','response',null);
  end if;
  return jsonb_build_object('status','matched','response',v_saved_response);
end;
$$;

revoke all on function public.ate_personal_sync_inspect_device(uuid) from public,anon;
revoke all on function public.ate_personal_sync_lookup_receipt(jsonb) from public,anon;
grant execute on function public.ate_personal_sync_inspect_device(uuid) to authenticated;
grant execute on function public.ate_personal_sync_lookup_receipt(jsonb) to authenticated;

comment on function public.ate_personal_sync_inspect_device(uuid) is
  'Read-only per-owner server cursor and current-device state; never registers or resets a device.';
comment on function public.ate_personal_sync_lookup_receipt(jsonb) is
  'Read-only, authenticated exact-operation idempotency lookup; never exposes saved request or content.';
