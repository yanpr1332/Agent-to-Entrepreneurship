-- V02-SYNC-02: Explicit small personal files, stored transactionally inside PostgreSQL.
-- Run ONLY in an owner-controlled disposable Supabase project AFTER the seven
-- earlier migrations. No service-role/client secret, production data, or automation.
-- Bounded beta MVP: 20 active files/account, 1 MiB/file. DB bytea is deliberate
-- until a separately reviewed private-Storage protocol supports larger files.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ate_personal_files (
  owner_id uuid not null references auth.users(id) on delete cascade,
  file_id uuid not null,
  filename text not null,
  version bigint not null check (version > 0),
  sha256 text,
  byte_length integer not null default 0 check (byte_length between 0 and 1048576),
  content bytea,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(owner_id,file_id),
  constraint ate_files_content_consistency check (
    (deleted and content is null and sha256 is null and byte_length=0) or
    (not deleted and content is not null and sha256 ~ '^[a-f0-9]{64}$'
      and octet_length(content)=byte_length)
  ),
  constraint ate_files_name_valid check (
    char_length(filename) between 1 and 128
    and filename=trim(filename)
    and filename !~ '[[:cntrl:]]'
    and position('/' in filename)=0 and position(chr(92) in filename)=0
    and filename not in ('.','..')
  )
);
create index if not exists ate_personal_files_owner_time
  on public.ate_personal_files(owner_id,updated_at desc);
alter table public.ate_personal_files enable row level security;
-- No direct table access is granted to the desktop. SECURITY DEFINER RPCs
-- below manually enforce auth.uid() and reveal only current owner's data.
revoke all on public.ate_personal_files from public,anon,authenticated;

create or replace function public.ate_file_list()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'authentication required' using errcode='28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'fileId',f.file_id,'filename',f.filename,'version',f.version,
    'sha256',f.sha256,'byteLength',f.byte_length,
    'updatedAt',to_char(f.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) order by f.updated_at desc,f.file_id)
    from public.ate_personal_files f
    where f.owner_id=v_owner and f.deleted=false),'[]'::jsonb);
end;
$$;

create or replace function public.ate_file_get(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid := auth.uid(); v_file public.ate_personal_files%rowtype;
begin
  if v_owner is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_file from public.ate_personal_files
    where owner_id=v_owner and file_id=p_file_id and deleted=false;
  if not found then raise exception 'file unavailable or permission denied' using errcode='42501'; end if;
  return jsonb_build_object(
    'fileId',v_file.file_id,'filename',v_file.filename,'version',v_file.version,
    'sha256',v_file.sha256,'byteLength',v_file.byte_length,
    'base64',encode(v_file.content,'base64')
  );
end;
$$;

-- A per-(owner,file) lock serializes simultaneous FIRST writers, while
-- SELECT FOR UPDATE serializes subsequent writers. Refuses overwrite on
-- stale baseVersion. Duplicate is only returned for byte/name-identical
-- retries (e.g. server committed but HTTP response was lost).
create or replace function public.ate_file_apply(
  p_file_id uuid,p_base_version bigint,p_filename text,
  p_sha256 text,p_byte_length integer,p_base64 text,p_delete boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.ate_personal_files%rowtype;
  v_bytes bytea;
  v_version bigint;
begin
  if v_owner is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_file_id is null or p_base_version is null or p_base_version<0
    or p_base_version>9223372036854775806
    or p_delete is null then
    raise exception 'invalid file operation' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text||':'||p_file_id::text,0));
  select * into v_row from public.ate_personal_files
    where owner_id=v_owner and file_id=p_file_id for update;
  if p_delete then
    if not found then return jsonb_build_object('status','conflict','version',null); end if;
    if v_row.deleted then return jsonb_build_object('status','duplicate','version',v_row.version); end if;
    if v_row.version<>p_base_version then
      return jsonb_build_object('status','conflict','version',v_row.version);
    end if;
    update public.ate_personal_files set deleted=true,content=null,sha256=null,
      byte_length=0,version=version+1,updated_at=now()
      where owner_id=v_owner and file_id=p_file_id;
    return jsonb_build_object('status','accepted','version',v_row.version+1);
  end if;
  if p_filename is null or char_length(p_filename) not between 1 and 128
    or p_filename<>trim(p_filename) or p_filename ~ '[[:cntrl:]]'
    or position('/' in p_filename)>0 or position(chr(92) in p_filename)>0
    or p_filename in ('.','..') or p_sha256 !~ '^[a-f0-9]{64}$'
    or p_byte_length is null or p_byte_length<1 or p_byte_length>1048576
    or p_base64 is null or length(p_base64)>1400000
  then raise exception 'invalid file metadata' using errcode='22023'; end if;
  begin
    v_bytes := pg_catalog.decode(p_base64,'base64');
  exception when others then
    raise exception 'invalid file encoding' using errcode='22023';
  end;
  if pg_catalog.octet_length(v_bytes)<>p_byte_length
    or pg_catalog.encode(extensions.digest(v_bytes,'sha256'),'hex')<>p_sha256 then
    raise exception 'file checksum mismatch' using errcode='22023';
  end if;
  if found and not v_row.deleted and v_row.sha256=p_sha256
    and v_row.filename=p_filename then
    return jsonb_build_object('status','duplicate','version',v_row.version);
  end if;
  if found then
    if v_row.version<>p_base_version then
      return jsonb_build_object('status','conflict','version',v_row.version);
    end if;
    v_version := v_row.version+1;
    update public.ate_personal_files set filename=p_filename,sha256=p_sha256,
      byte_length=p_byte_length,content=v_bytes,deleted=false,
      version=v_version,updated_at=now()
    where owner_id=v_owner and file_id=p_file_id;
  else
    if p_base_version<>0 then
      return jsonb_build_object('status','conflict','version',null);
    end if;
    if (select count(*) from public.ate_personal_files
      where owner_id=v_owner and deleted=false)>=20 then
      raise exception 'personal file quota exceeded' using errcode='22023';
    end if;
    v_version:=1;
    insert into public.ate_personal_files(owner_id,file_id,filename,version,
      sha256,byte_length,content,deleted)
      values(v_owner,p_file_id,p_filename,v_version,p_sha256,p_byte_length,v_bytes,false);
  end if;
  return jsonb_build_object('status','accepted','version',v_version);
end;
$$;

revoke all on function public.ate_file_list() from public,anon,authenticated;
revoke all on function public.ate_file_get(uuid) from public,anon,authenticated;
revoke all on function public.ate_file_apply(uuid,bigint,text,text,integer,text,boolean)
  from public,anon,authenticated;
grant execute on function public.ate_file_list() to authenticated;
grant execute on function public.ate_file_get(uuid) to authenticated;
grant execute on function public.ate_file_apply(uuid,bigint,text,text,integer,text,boolean)
  to authenticated;
