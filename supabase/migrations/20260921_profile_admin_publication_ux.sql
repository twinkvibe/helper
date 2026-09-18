-- 20260921_profile_admin_publication_ux.sql
-- Atomic migration: Profile display name, public profile RPC, unlisted article access RPC,
-- public author articles, safe public profile check, and DB-level active admin invariant
begin;

-- 1. profiles.display_name
alter table public.profiles add column if not exists display_name text check (display_name is null or char_length(trim(display_name)) between 1 and 80);

-- 2. set_profile_display_name RPC (fails for unauthenticated or blocked users)
create or replace function public.set_profile_display_name(new_display_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  clean_name text;
  is_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;
  select blocked into is_blocked from public.profiles where id = auth.uid();
  if is_blocked is null then
    raise exception 'Профиль не найден';
  end if;
  if is_blocked then
    raise exception 'Доступ закрыт: профиль заблокирован';
  end if;
  clean_name := nullif(trim(new_display_name), '');
  if clean_name is not null and (char_length(clean_name) < 1 or char_length(clean_name) > 80) then
    raise exception 'Отображаемое имя должно быть от 1 до 80 символов';
  end if;
  update public.profiles set display_name = clean_name where id = auth.uid();
end; $$;
revoke all on function public.set_profile_display_name(text) from public;
grant execute on function public.set_profile_display_name(text) to authenticated;

-- 3. set_profile_avatar RPC (fails for unauthenticated or blocked users)
create or replace function public.set_profile_avatar(avatar text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  is_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;
  select blocked into is_blocked from public.profiles where id = auth.uid();
  if is_blocked is null then
    raise exception 'Профиль не найден';
  end if;
  if is_blocked then
    raise exception 'Доступ закрыт: профиль заблокирован';
  end if;
  if avatar is not null and avatar !~ '^https://' then
    raise exception 'Некорректный URL аватарки';
  end if;
  update public.profiles set avatar_url = avatar where id = auth.uid();
end; $$;
revoke all on function public.set_profile_avatar(text) from public;
grant execute on function public.set_profile_avatar(text) to authenticated;

-- 4. Minimal security definer function to check active profile without exposing profiles to anon SELECT
create or replace function public.is_public_profile(profile_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles where id = profile_id and not blocked
  );
$$;
revoke all on function public.is_public_profile(uuid) from public;
grant execute on function public.is_public_profile(uuid) to anon, authenticated;

-- 5. get_public_profile RPC (projects only safe public fields)
create or replace function public.get_public_profile(profile_username text)
returns table (
  username text,
  display_name text,
  avatar_url text
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  select p.username, p.display_name, p.avatar_url
  from public.profiles p
  where p.username = profile_username
    and not p.blocked
  limit 1;
end; $$;
revoke all on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated;

-- 6. Restrict direct SELECT on articles to public only using public.is_public_profile (prevent unlisted enumeration)
drop policy if exists "Anyone reads public or unlisted articles" on public.articles;
drop policy if exists "Anyone reads public articles" on public.articles;
create policy "Anyone reads public articles" on public.articles
  for select using (
    access = 'public' and public.is_public_profile(user_id)
  );

-- 7. get_article_by_slug RPC (supports public and unlisted by exact slug)
create or replace function public.get_article_by_slug(article_slug text)
returns table (
  id uuid,
  title text,
  slug text,
  body text,
  excerpt text,
  cover_url text,
  author_name text,
  author_display_name text,
  author_avatar_url text,
  access text,
  published_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  select
    a.id,
    a.title,
    a.slug,
    a.body,
    a.excerpt,
    a.cover_url,
    a.author_name,
    p.display_name as author_display_name,
    p.avatar_url as author_avatar_url,
    a.access,
    a.published_at
  from public.articles a
  join public.profiles p on p.id = a.user_id
  where a.slug = article_slug
    and a.access in ('public', 'unlisted')
    and not p.blocked
  limit 1;
end; $$;
revoke all on function public.get_article_by_slug(text) from public;
grant execute on function public.get_article_by_slug(text) to anon, authenticated;

-- 8. get_public_articles_by_author RPC
create or replace function public.get_public_articles_by_author(author_username text)
returns table (
  id uuid,
  title text,
  slug text,
  excerpt text,
  cover_url text,
  published_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  select
    a.id,
    a.title,
    a.slug,
    a.excerpt,
    a.cover_url,
    a.published_at
  from public.articles a
  join public.profiles p on p.id = a.user_id
  where p.username = author_username
    and a.access = 'public'
    and not p.blocked
  order by a.published_at desc;
end; $$;
revoke all on function public.get_public_articles_by_author(text) from public;
grant execute on function public.get_public_articles_by_author(text) to anon, authenticated;

-- 9. Active admin invariant trigger at DB level (with transaction advisory lock)
create or replace function public.ensure_active_admin_exists()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  remaining_admins int;
begin
  if (OLD.role = 'admin' and not OLD.blocked) and
     (TG_OP = 'DELETE' or NEW.role <> 'admin' or NEW.blocked) then
    perform pg_advisory_xact_lock(5482910394857201);
    select count(*) into remaining_admins
    from public.profiles
    where role = 'admin' and not blocked and id <> OLD.id;

    if remaining_admins < 1 then
      raise exception 'Нельзя удалить, заблокировать или понизить последнего активного администратора';
    end if;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end; $$;

drop trigger if exists protect_active_admin on public.profiles;
create trigger protect_active_admin
  before update or delete on public.profiles
  for each row
  execute function public.ensure_active_admin_exists();

commit;
