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
create or replace function public.set_article_author_name() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select username into new.author_name from public.profiles where id = new.user_id;
  return new;
end; $$;
create trigger articles_author_name before insert or update on public.articles for each row execute function public.set_article_author_name();
commit;
