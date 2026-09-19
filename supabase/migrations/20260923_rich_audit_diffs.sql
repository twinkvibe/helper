-- 20260923_rich_audit_diffs.sql
-- Audit log v2: text snapshots (bounded to 100k chars), image changes,
-- duplicate suppression for service-role actions, and profile self-service change auditing.
begin;

-- 1. Enhanced log_data_change()
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
  v_text_changes jsonb := '{}'::jsonb;
  v_desc_changed boolean := false;
  v_body_changed boolean := false;
begin
  -- Skip service-role writes with no auth.uid() to avoid duplicate records with Edge functions
  if auth.uid() is null then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

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
      if NEW.description is not null then
        v_text_changes := jsonb_build_object(
          'description', jsonb_build_object(
            'before', null,
            'after', left(NEW.description, 100000),
            'before_length', 0,
            'after_length', char_length(NEW.description),
            'before_hash', null,
            'after_hash', md5(NEW.description),
            'before_truncated', false,
            'after_truncated', (char_length(NEW.description) > 100000)
          )
        );
      end if;
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description'),
        'before', null,
        'after', v_after,
        'description_changed', false,
        'description_length_after', char_length(coalesce(NEW.description, '')),
        'text_changes', v_text_changes
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
      if NEW.body is not null then
        v_text_changes := jsonb_build_object(
          'body', jsonb_build_object(
            'before', null,
            'after', left(NEW.body, 100000),
            'before_length', 0,
            'after_length', char_length(NEW.body),
            'before_hash', null,
            'after_hash', md5(NEW.body),
            'before_truncated', false,
            'after_truncated', (char_length(NEW.body) > 100000)
          )
        );
      end if;
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'slug', 'excerpt', 'cover_url', 'access', 'published', 'published_at', 'body'),
        'before', null,
        'after', v_after,
        'body_changed', false,
        'body_length_after', char_length(coalesce(NEW.body, '')),
        'text_changes', v_text_changes
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
      if OLD.description is not null then
        v_text_changes := jsonb_build_object(
          'description', jsonb_build_object(
            'before', left(OLD.description, 100000),
            'after', null,
            'before_length', char_length(OLD.description),
            'after_length', 0,
            'before_hash', md5(OLD.description),
            'after_hash', null,
            'before_truncated', (char_length(OLD.description) > 100000),
            'after_truncated', false
          )
        );
      end if;
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description'),
        'before', v_before,
        'after', null,
        'description_changed', false,
        'description_length_before', char_length(coalesce(OLD.description, '')),
        'text_changes', v_text_changes
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
      if OLD.body is not null then
        v_text_changes := jsonb_build_object(
          'body', jsonb_build_object(
            'before', left(OLD.body, 100000),
            'after', null,
            'before_length', char_length(OLD.body),
            'after_length', 0,
            'before_hash', md5(OLD.body),
            'after_hash', null,
            'before_truncated', (char_length(OLD.body) > 100000),
            'after_truncated', false
          )
        );
      end if;
      v_details := jsonb_build_object(
        'changed_fields', jsonb_build_array('title', 'slug', 'excerpt', 'cover_url', 'access', 'published', 'published_at', 'body'),
        'before', v_before,
        'after', null,
        'body_changed', false,
        'body_length_before', char_length(coalesce(OLD.body, '')),
        'text_changes', v_text_changes
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
        v_text_changes := jsonb_build_object(
          'description', jsonb_build_object(
            'before', case when OLD.description is not null then left(OLD.description, 100000) else null end,
            'after', case when NEW.description is not null then left(NEW.description, 100000) else null end,
            'before_length', char_length(coalesce(OLD.description, '')),
            'after_length', char_length(coalesce(NEW.description, '')),
            'before_hash', case when OLD.description is not null then md5(OLD.description) else null end,
            'after_hash', case when NEW.description is not null then md5(NEW.description) else null end,
            'before_truncated', (char_length(coalesce(OLD.description, '')) > 100000),
            'after_truncated', (char_length(coalesce(NEW.description, '')) > 100000)
          )
        );
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
          'description_length_after', char_length(coalesce(NEW.description, '')),
          'text_changes', v_text_changes
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
        v_text_changes := jsonb_build_object(
          'body', jsonb_build_object(
            'before', case when OLD.body is not null then left(OLD.body, 100000) else null end,
            'after', case when NEW.body is not null then left(NEW.body, 100000) else null end,
            'before_length', char_length(coalesce(OLD.body, '')),
            'after_length', char_length(coalesce(NEW.body, '')),
            'before_hash', case when OLD.body is not null then md5(OLD.body) else null end,
            'after_hash', case when NEW.body is not null then md5(NEW.body) else null end,
            'before_truncated', (char_length(coalesce(OLD.body, '')) > 100000),
            'after_truncated', (char_length(coalesce(NEW.body, '')) > 100000)
          )
        );
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
          'body_length_after', char_length(coalesce(NEW.body, '')),
          'text_changes', v_text_changes
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

-- 2. Audited set_profile_display_name
create or replace function public.set_profile_display_name(new_display_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_name text;
  v_username text;
  clean_name text;
  is_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;
  select display_name, username, blocked
    into old_name, v_username, is_blocked
    from public.profiles
   where id = auth.uid();
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
  if old_name is distinct from clean_name then
    insert into public.audit_logs(actor_id, action, entity, entity_id, details)
    values (
      auth.uid(),
      'profile_display_name',
      'profiles',
      auth.uid(),
      jsonb_build_object(
        'username', v_username,
        'changed_fields', jsonb_build_array('display_name'),
        'before', jsonb_build_object('display_name', old_name),
        'after', jsonb_build_object('display_name', clean_name)
      )
    );
  end if;
end;
$$;
revoke all on function public.set_profile_display_name(text) from public, anon;
grant execute on function public.set_profile_display_name(text) to authenticated;

-- 3. Audited set_profile_avatar
create or replace function public.set_profile_avatar(avatar text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_avatar text;
  v_username text;
  is_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;
  select avatar_url, username, blocked
    into old_avatar, v_username, is_blocked
    from public.profiles
   where id = auth.uid();
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
  if old_avatar is distinct from avatar then
    insert into public.audit_logs(actor_id, action, entity, entity_id, details)
    values (
      auth.uid(),
      'profile_avatar',
      'profiles',
      auth.uid(),
      jsonb_build_object(
        'username', v_username,
        'changed_fields', jsonb_build_array('avatar_url'),
        'before', jsonb_build_object('avatar_url', old_avatar),
        'after', jsonb_build_object('avatar_url', avatar)
      )
    );
  end if;
end;
$$;
revoke all on function public.set_profile_avatar(text) from public, anon;
grant execute on function public.set_profile_avatar(text) to authenticated;

-- 4. Audited set_profile_bio
create or replace function public.set_profile_bio(new_bio text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_bio text;
  v_username text;
  clean_bio text;
  is_blocked boolean;
  v_must_cp boolean;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;
  select bio, username, blocked, must_change_password
    into old_bio, v_username, is_blocked, v_must_cp
    from public.profiles
   where id = auth.uid();
  if is_blocked is null then
    raise exception 'Профиль не найден';
  end if;
  if is_blocked then
    raise exception 'Доступ закрыт: профиль заблокирован';
  end if;
  clean_bio := nullif(trim(coalesce(new_bio, '')), '');
  if clean_bio is not null and char_length(clean_bio) > 280 then
    raise exception 'Био не может превышать 280 символов';
  end if;
  update public.profiles set bio = clean_bio where id = auth.uid();
  if old_bio is distinct from clean_bio then
    insert into public.audit_logs(actor_id, action, entity, entity_id, details)
    values (
      auth.uid(),
      'profile_bio',
      'profiles',
      auth.uid(),
      jsonb_build_object(
        'username', v_username,
        'changed_fields', jsonb_build_array('bio'),
        'before', jsonb_build_object('bio', old_bio),
        'after', jsonb_build_object('bio', clean_bio)
      )
    );
  end if;
end;
$$;
revoke all on function public.set_profile_bio(text) from public, anon;
grant execute on function public.set_profile_bio(text) to authenticated;

commit;

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';
