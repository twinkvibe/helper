-- 20260922_profile_bio_audit.sql
-- Adds a bio field to public.profiles (max 280 chars) and a
-- security-definer RPC so authenticated users can set their own bio.
-- Also updates get_public_profile to expose the bio field.
begin;

-- 1. Add bio column (idempotent)
alter table public.profiles
  add column if not exists bio text
    constraint profiles_bio_length check (char_length(bio) <= 280);

-- 2. RPC: set own bio
create or replace function public.set_profile_bio(new_bio text)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_blocked   boolean;
  v_must_cp   boolean;
  clean_bio   text;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;
  select blocked, must_change_password
    into v_blocked, v_must_cp
    from public.profiles
   where id = auth.uid();
  if not found then
    raise exception 'Профиль не найден';
  end if;
  if v_blocked then
    raise exception 'Доступ закрыт: профиль заблокирован';
  end if;
  clean_bio := nullif(trim(coalesce(new_bio, '')), '');
  if clean_bio is not null and char_length(clean_bio) > 280 then
    raise exception 'Био не может превышать 280 символов';
  end if;
  update public.profiles
     set bio = clean_bio
   where id = auth.uid();
end;
$$;

revoke all on function public.set_profile_bio(text) from public, anon;
grant execute on function public.set_profile_bio(text) to authenticated;

-- 3. Refresh get_public_profile to include bio
create or replace function public.get_public_profile(profile_username text)
  returns table (
    username     text,
    display_name text,
    avatar_url   text,
    bio          text
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  return query
  select p.username, p.display_name, p.avatar_url, p.bio
    from public.profiles p
   where p.username = profile_username
     and not p.blocked
   limit 1;
end;
$$;

revoke all on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated;

commit;
