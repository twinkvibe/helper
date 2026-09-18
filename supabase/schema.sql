begin;
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text not null unique check(username ~ '^[a-z0-9_]{3,32}$'),
 role text not null default 'member' check(role in ('admin','member')),
 blocked boolean not null default false,
 must_change_password boolean not null default true,
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
 published boolean not null default false,
 published_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check((published and published_at is not null) or (not published and published_at is null))
);
alter table public.articles enable row level security;
revoke all on public.articles from anon, authenticated;
grant select on public.articles to anon, authenticated;
grant insert, update, delete on public.articles to authenticated;
create policy "Anyone reads published articles" on public.articles for select using(published = true);
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
create or replace function public.log_data_change() returns trigger language plpgsql security definer set search_path = public as $$
declare row_data jsonb; object_id uuid; details jsonb;
begin
 row_data := case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end; object_id := (row_data->>'id')::uuid;
 details := jsonb_build_object('title', row_data->>'title', 'published', row_data->>'published', 'done', row_data->>'done');
 insert into public.audit_logs(actor_id, action, entity, entity_id, details) values(auth.uid(), lower(TG_OP), TG_TABLE_NAME, object_id, details);
 return case when TG_OP='DELETE' then old else new end;
end; $$;
create trigger todos_audit_log after insert or update or delete on public.todos for each row execute function public.log_data_change();
create trigger articles_audit_log after insert or update or delete on public.articles for each row execute function public.log_data_change();
create index audit_logs_recent on public.audit_logs(created_at desc);
create or replace function public.record_client_error(error_message text, error_context text default '') returns void language plpgsql security definer set search_path = public as $$
begin
 insert into public.audit_logs(actor_id, action, entity, details) values(auth.uid(), 'error', 'client', jsonb_build_object('message', left(coalesce(error_message,''),500), 'context', left(coalesce(error_context,''),120)));
end; $$;
revoke all on function public.record_client_error(text,text) from public;
grant execute on function public.record_client_error(text,text) to authenticated;
create or replace function public.set_article_author_name() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select username into new.author_name from public.profiles where id = new.user_id;
  return new;
end; $$;
create trigger articles_author_name before insert or update on public.articles for each row execute function public.set_article_author_name();
commit;
