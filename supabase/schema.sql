begin;
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text not null unique check(username ~ '^[a-z0-9_]{3,32}$'),
 role text not null default 'member' check(role in ('admin','member')),
 blocked boolean not null default false,
 must_change_password boolean not null default true,
 display_name text check(display_name is null or char_length(trim(display_name)) between 1 and 80),
 avatar_url text check(avatar_url is null or avatar_url ~ '^https://'),
 bio text constraint profiles_bio_length check(char_length(bio) <= 280),
 created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
create policy "Read own profile" on public.profiles for select to authenticated using(id = (select auth.uid()));
create table public.todos (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check(char_length(trim(title)) between 1 and 500),
 done boolean not null default false,
 description text not null default '' check(char_length(description) <= 5000000),
 list_name text not null default 'Входящие' check(char_length(list_name) between 1 and 80),
 due_date date,
 priority integer not null default 0 check(priority between 0 and 2),
 note_id uuid,
 tags text[] not null default '{}' check(cardinality(tags) <= 20),
 created_at timestamptz not null default now()
);
alter table public.todos enable row level security;
revoke all on public.todos from anon, authenticated;
grant select, insert, update, delete on public.todos to authenticated;
create policy "Active users manage own tasks" on public.todos for all to authenticated
 using(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
 with check(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));
create index todos_user_created on public.todos(user_id, created_at desc);
create table public.articles (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check(char_length(trim(title)) between 1 and 180),
 slug text not null unique check(slug ~ '^[a-z0-9а-яё-]{1,80}$'),
 body text not null default '' check(char_length(body) <= 5000000),
 excerpt text not null default '' check(char_length(excerpt) <= 220),
 cover_url text check(cover_url is null or cover_url ~ '^https://'),
 author_name text not null check(char_length(author_name) between 3 and 32),
 author_avatar_url text,
 access text not null default 'private' check(access in ('public','unlisted','private')),
 published boolean not null default false,
 published_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check((published and published_at is not null) or (not published and published_at is null))
);
alter table public.articles enable row level security;
revoke all on public.articles from anon, authenticated;
grant select on public.articles to anon, authenticated;
create or replace function public.is_public_profile(profile_id uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.profiles where id = profile_id and not blocked);
$$;
revoke all on function public.is_public_profile(uuid) from public;
grant execute on function public.is_public_profile(uuid) to anon, authenticated;
create policy "Anyone reads public articles" on public.articles for select using(access = 'public' and public.is_public_profile(user_id));
create policy "Active users manage own articles" on public.articles for all to authenticated
 using(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
 with check(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));
create index articles_public_recent on public.articles(published_at desc) where published;
create index articles_owner_recent on public.articles(user_id, updated_at desc);
create table public.audit_logs (
 id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id) on delete set null,
 action text not null, entity text not null, entity_id uuid, details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
create policy "Admins read audit logs" on public.audit_logs for select to authenticated using(exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin' and not blocked and not must_change_password));
create or replace function public.log_data_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_object_id uuid;
  v_details jsonb := '{}'::jsonb;
  v_changed_fields text[] := '{}';
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_desc_changed boolean := false;
  v_body_changed boolean := false;
begin
  if TG_OP = 'INSERT' then
    v_object_id := NEW.id;
    if TG_TABLE_NAME = 'todos' then
      v_after := jsonb_build_object(
        'title', NEW.title,
        'done', NEW.done,
        'list_name', NEW.list_name,
        'due_date', NEW.due_date,
        'priority', NEW.priority,
        'tags', to_jsonb(NEW.tags),
        'note_id', NEW.note_id
      );
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description'),
        'before', null,
        'after', v_after,
        'description_changed', false,
        'description_length_after', char_length(coalesce(NEW.description, ''))
      );
    elsif TG_TABLE_NAME = 'articles' then
      v_after := jsonb_build_object(
        'title', NEW.title,
        'slug', NEW.slug,
        'excerpt', NEW.excerpt,
        'cover_url', NEW.cover_url,
        'access', NEW.access,
        'published', NEW.published,
        'published_at', NEW.published_at
      );
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'slug', 'excerpt', 'cover_url', 'access', 'published', 'published_at', 'body'),
        'before', null,
        'after', v_after,
        'body_changed', false,
        'body_length_after', char_length(coalesce(NEW.body, ''))
      );
    end if;

  elsif TG_OP = 'DELETE' then
    v_object_id := OLD.id;
    if TG_TABLE_NAME = 'todos' then
      v_before := jsonb_build_object(
        'title', OLD.title,
        'done', OLD.done,
        'list_name', OLD.list_name,
        'due_date', OLD.due_date,
        'priority', OLD.priority,
        'tags', to_jsonb(OLD.tags),
        'note_id', OLD.note_id
      );
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description'),
        'before', v_before,
        'after', null,
        'description_changed', false,
        'description_length_before', char_length(coalesce(OLD.description, ''))
      );
    elsif TG_TABLE_NAME = 'articles' then
      v_before := jsonb_build_object(
        'title', OLD.title,
        'slug', OLD.slug,
        'excerpt', OLD.excerpt,
        'cover_url', OLD.cover_url,
        'access', OLD.access,
        'published', OLD.published,
        'published_at', OLD.published_at
      );
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'slug', 'excerpt', 'cover_url', 'access', 'published', 'published_at', 'body'),
        'before', v_before,
        'after', null,
        'body_changed', false,
        'body_length_before', char_length(coalesce(OLD.body, ''))
      );
    end if;

  elsif TG_OP = 'UPDATE' then
    v_object_id := NEW.id;
    if TG_TABLE_NAME = 'todos' then
      if OLD.title is distinct from NEW.title then
        v_changed_fields := array_append(v_changed_fields, 'title');
        v_before := v_before || jsonb_build_object('title', OLD.title);
        v_after := v_after || jsonb_build_object('title', NEW.title);
      end if;
      if OLD.done is distinct from NEW.done then
        v_changed_fields := array_append(v_changed_fields, 'done');
        v_before := v_before || jsonb_build_object('done', OLD.done);
        v_after := v_after || jsonb_build_object('done', NEW.done);
      end if;
      if OLD.list_name is distinct from NEW.list_name then
        v_changed_fields := array_append(v_changed_fields, 'list_name');
        v_before := v_before || jsonb_build_object('list_name', OLD.list_name);
        v_after := v_after || jsonb_build_object('list_name', NEW.list_name);
      end if;
      if OLD.due_date is distinct from NEW.due_date then
        v_changed_fields := array_append(v_changed_fields, 'due_date');
        v_before := v_before || jsonb_build_object('due_date', OLD.due_date);
        v_after := v_after || jsonb_build_object('due_date', NEW.due_date);
      end if;
      if OLD.priority is distinct from NEW.priority then
        v_changed_fields := array_append(v_changed_fields, 'priority');
        v_before := v_before || jsonb_build_object('priority', OLD.priority);
        v_after := v_after || jsonb_build_object('priority', NEW.priority);
      end if;
      if OLD.tags is distinct from NEW.tags then
        v_changed_fields := array_append(v_changed_fields, 'tags');
        v_before := v_before || jsonb_build_object('tags', to_jsonb(OLD.tags));
        v_after := v_after || jsonb_build_object('tags', to_jsonb(NEW.tags));
      end if;
      if OLD.note_id is distinct from NEW.note_id then
        v_changed_fields := array_append(v_changed_fields, 'note_id');
        v_before := v_before || jsonb_build_object('note_id', OLD.note_id);
        v_after := v_after || jsonb_build_object('note_id', NEW.note_id);
      end if;

      v_desc_changed := (OLD.description is distinct from NEW.description);
      if v_desc_changed then
        v_changed_fields := array_append(v_changed_fields, 'description');
      end if;

      v_details := jsonb_build_object(
        'changed_fields', to_jsonb(v_changed_fields),
        'before', v_before,
        'after', v_after,
        'description_changed', v_desc_changed
      );
      if v_desc_changed then
        v_details := v_details || jsonb_build_object(
          'description_length_before', char_length(coalesce(OLD.description, '')),
          'description_length_after', char_length(coalesce(NEW.description, ''))
        );
      end if;

    elsif TG_TABLE_NAME = 'articles' then
      if OLD.title is distinct from NEW.title then
        v_changed_fields := array_append(v_changed_fields, 'title');
        v_before := v_before || jsonb_build_object('title', OLD.title);
        v_after := v_after || jsonb_build_object('title', NEW.title);
      end if;
      if OLD.slug is distinct from NEW.slug then
        v_changed_fields := array_append(v_changed_fields, 'slug');
        v_before := v_before || jsonb_build_object('slug', OLD.slug);
        v_after := v_after || jsonb_build_object('slug', NEW.slug);
      end if;
      if OLD.excerpt is distinct from NEW.excerpt then
        v_changed_fields := array_append(v_changed_fields, 'excerpt');
        v_before := v_before || jsonb_build_object('excerpt', OLD.excerpt);
        v_after := v_after || jsonb_build_object('excerpt', NEW.excerpt);
      end if;
      if OLD.cover_url is distinct from NEW.cover_url then
        v_changed_fields := array_append(v_changed_fields, 'cover_url');
        v_before := v_before || jsonb_build_object('cover_url', OLD.cover_url);
        v_after := v_after || jsonb_build_object('cover_url', NEW.cover_url);
      end if;
      if OLD.access is distinct from NEW.access then
        v_changed_fields := array_append(v_changed_fields, 'access');
        v_before := v_before || jsonb_build_object('access', OLD.access);
        v_after := v_after || jsonb_build_object('access', NEW.access);
      end if;
      if OLD.published is distinct from NEW.published then
        v_changed_fields := array_append(v_changed_fields, 'published');
        v_before := v_before || jsonb_build_object('published', OLD.published);
        v_after := v_after || jsonb_build_object('published', NEW.published);
      end if;
      if OLD.published_at is distinct from NEW.published_at then
        v_changed_fields := array_append(v_changed_fields, 'published_at');
        v_before := v_before || jsonb_build_object('published_at', OLD.published_at);
        v_after := v_after || jsonb_build_object('published_at', NEW.published_at);
      end if;

      v_body_changed := (OLD.body is distinct from NEW.body);
      if v_body_changed then
        v_changed_fields := array_append(v_changed_fields, 'body');
      end if;

      v_details := jsonb_build_object(
        'changed_fields', to_jsonb(v_changed_fields),
        'before', v_before,
        'after', v_after,
        'body_changed', v_body_changed
      );
      if v_body_changed then
        v_details := v_details || jsonb_build_object(
          'body_length_before', char_length(coalesce(OLD.body, '')),
          'body_length_after', char_length(coalesce(NEW.body, ''))
        );
      end if;
    end if;
  end if;

  if TG_OP = 'DELETE' then
    if OLD.title is not null then
      v_details := v_details || jsonb_build_object('title', OLD.title);
    end if;
  else
    if NEW.title is not null then
      v_details := v_details || jsonb_build_object('title', NEW.title);
    end if;
  end if;

  insert into public.audit_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), lower(TG_OP), TG_TABLE_NAME, v_object_id, v_details);

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;
create trigger todos_audit_log after insert or update or delete on public.todos for each row execute function public.log_data_change();
create trigger articles_audit_log after insert or update or delete on public.articles for each row execute function public.log_data_change();
create index audit_logs_recent on public.audit_logs(created_at desc);
create or replace function public.set_profile_avatar(avatar text) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  is_blocked boolean;
begin
  if auth.uid() is null then raise exception 'Требуется авторизация'; end if;
  select blocked into is_blocked from public.profiles where id = auth.uid();
  if is_blocked is null then raise exception 'Профиль не найден'; end if;
  if is_blocked then raise exception 'Доступ закрыт: профиль заблокирован'; end if;
  if avatar is not null and avatar !~ '^https://' then raise exception 'Некорректный URL аватарки'; end if;
  update public.profiles set avatar_url=avatar where id=auth.uid();
end; $$;
revoke all on function public.set_profile_avatar(text) from public;
grant execute on function public.set_profile_avatar(text) to authenticated;
create or replace function public.record_client_error(error_message text, error_context text default '') returns void language plpgsql security definer set search_path = public as $$
begin
 insert into public.audit_logs(actor_id, action, entity, details) values(auth.uid(), 'error', 'client', jsonb_build_object('message', left(coalesce(error_message,''),500), 'context', left(coalesce(error_context,''),120)));
end; $$;
revoke all on function public.record_client_error(text,text) from public;
grant execute on function public.record_client_error(text,text) to authenticated;
create or replace function public.set_article_author_name() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select username, avatar_url into new.author_name, new.author_avatar_url from public.profiles where id = new.user_id;
  return new;
end; $$;
create trigger articles_author_name before insert or update on public.articles for each row execute function public.set_article_author_name();
create or replace function public.set_profile_display_name(new_display_name text) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  clean_name text;
  is_blocked boolean;
begin
  if auth.uid() is null then raise exception 'Требуется авторизация'; end if;
  select blocked into is_blocked from public.profiles where id = auth.uid();
  if is_blocked is null then raise exception 'Профиль не найден'; end if;
  if is_blocked then raise exception 'Доступ закрыт: профиль заблокирован'; end if;
  clean_name := nullif(trim(new_display_name), '');
  if clean_name is not null and (char_length(clean_name) < 1 or char_length(clean_name) > 80) then
    raise exception 'Отображаемое имя должно быть от 1 до 80 символов';
  end if;
  update public.profiles set display_name = clean_name where id = auth.uid();
end; $$;
revoke all on function public.set_profile_display_name(text) from public;
grant execute on function public.set_profile_display_name(text) to authenticated;
create or replace function public.get_public_profile(profile_username text) returns table (username text, display_name text, avatar_url text) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query select p.username, p.display_name, p.avatar_url from public.profiles p where p.username = profile_username and not p.blocked limit 1;
end; $$;
revoke all on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated;
create or replace function public.get_article_by_slug(article_slug text) returns table (id uuid, title text, slug text, body text, excerpt text, cover_url text, author_name text, author_display_name text, author_avatar_url text, access text, published_at timestamptz) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query select a.id, a.title, a.slug, a.body, a.excerpt, a.cover_url, a.author_name, p.display_name as author_display_name, p.avatar_url as author_avatar_url, a.access, a.published_at from public.articles a join public.profiles p on p.id = a.user_id where a.slug = article_slug and a.access in ('public', 'unlisted') and not p.blocked limit 1;
end; $$;
revoke all on function public.get_article_by_slug(text) from public;
grant execute on function public.get_article_by_slug(text) to anon, authenticated;
create or replace function public.get_public_articles_by_author(author_username text) returns table (id uuid, title text, slug text, excerpt text, cover_url text, published_at timestamptz) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query select a.id, a.title, a.slug, a.excerpt, a.cover_url, a.published_at from public.articles a join public.profiles p on p.id = a.user_id where p.username = author_username and a.access = 'public' and not p.blocked order by a.published_at desc;
end; $$;
revoke all on function public.get_public_articles_by_author(text) from public;
grant execute on function public.get_public_articles_by_author(text) to anon, authenticated;
create or replace function public.ensure_active_admin_exists() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
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
