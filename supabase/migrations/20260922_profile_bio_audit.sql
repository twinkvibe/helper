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

-- 4. Structured audit diff in log_data_change()
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

drop trigger if exists todos_audit_log on public.todos;
create trigger todos_audit_log after insert or update or delete on public.todos for each row execute function public.log_data_change();

drop trigger if exists articles_audit_log on public.articles;
create trigger articles_audit_log after insert or update or delete on public.articles for each row execute function public.log_data_change();

commit;
