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
 created_at timestamptz not null default now()
);
alter table public.todos enable row level security;
revoke all on public.todos from anon, authenticated;
grant select, insert, update, delete on public.todos to authenticated;
create policy "Active users manage own tasks" on public.todos for all to authenticated
 using(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
 with check(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));
create index todos_user_created on public.todos(user_id, created_at desc);
commit;
