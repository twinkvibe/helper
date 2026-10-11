-- Досье: личные записи о людях и связанных событиях.
-- Данные принадлежат владельцу (RLS как у todos) и синхронизируются между устройствами.
-- Идемпотентная миграция: безопасна к повторному запуску.

-- Общий триггер updated_at
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

-- Люди
create table if not exists public.dossier_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check(char_length(trim(name)) between 1 and 120),
  aliases text[] not null default '{}' check(cardinality(aliases) <= 20),
  relation text not null default '' check(char_length(relation) <= 120),
  bio text not null default '' check(char_length(bio) <= 20000),
  avatar_url text check(avatar_url is null or avatar_url ~ '^https://'),
  tags text[] not null default '{}' check(cardinality(tags) <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.dossier_people enable row level security;
revoke all on public.dossier_people from anon, authenticated;
grant select, insert, update, delete on public.dossier_people to authenticated;
drop policy if exists "Active users manage own dossier people" on public.dossier_people;
create policy "Active users manage own dossier people" on public.dossier_people for all to authenticated
  using(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
  with check(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));
create index if not exists dossier_people_user on public.dossier_people(user_id, updated_at desc);
drop trigger if exists dossier_people_touch on public.dossier_people;
create trigger dossier_people_touch before update on public.dossier_people for each row execute function public.touch_updated_at();

-- События (записи/воспоминания)
create table if not exists public.dossier_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check(char_length(trim(title)) between 1 and 300),
  body text not null default '' check(char_length(body) <= 5000000),
  occurred_at timestamptz,
  mood text not null default '' check(char_length(mood) <= 40),
  tags text[] not null default '{}' check(cardinality(tags) <= 20),
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.dossier_entries enable row level security;
revoke all on public.dossier_entries from anon, authenticated;
grant select, insert, update, delete on public.dossier_entries to authenticated;
drop policy if exists "Active users manage own dossier entries" on public.dossier_entries;
create policy "Active users manage own dossier entries" on public.dossier_entries for all to authenticated
  using(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
  with check(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));
create index if not exists dossier_entries_user on public.dossier_entries(user_id, occurred_at desc nulls last, created_at desc);
drop trigger if exists dossier_entries_touch on public.dossier_entries;
create trigger dossier_entries_touch before update on public.dossier_entries for each row execute function public.touch_updated_at();

-- Связь событий и людей
create table if not exists public.dossier_entry_people (
  entry_id uuid not null references public.dossier_entries(id) on delete cascade,
  person_id uuid not null references public.dossier_people(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, person_id)
);
alter table public.dossier_entry_people enable row level security;
revoke all on public.dossier_entry_people from anon, authenticated;
grant select, insert, update, delete on public.dossier_entry_people to authenticated;
drop policy if exists "Active users manage own dossier links" on public.dossier_entry_people;
create policy "Active users manage own dossier links" on public.dossier_entry_people for all to authenticated
  using(
    user_id = (select auth.uid())
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
    and exists(select 1 from public.dossier_entries e where e.id = entry_id and e.user_id = (select auth.uid()))
    and exists(select 1 from public.dossier_people p where p.id = person_id and p.user_id = (select auth.uid()))
  )
  with check(
    user_id = (select auth.uid())
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
    and exists(select 1 from public.dossier_entries e where e.id = entry_id and e.user_id = (select auth.uid()))
    and exists(select 1 from public.dossier_people p where p.id = person_id and p.user_id = (select auth.uid()))
  );
create index if not exists dossier_link_person on public.dossier_entry_people(user_id, person_id);
create index if not exists dossier_link_entry on public.dossier_entry_people(entry_id);

-- Приватное хранилище фотографий досье: доступ только владельцу каталога <uid>/...
insert into storage.buckets (id, name, public) values ('dossier-media', 'dossier-media', false)
  on conflict (id) do update set public = false;

drop policy if exists "Users read own dossier media" on storage.objects;
create policy "Users read own dossier media" on storage.objects for select to authenticated
  using (bucket_id = 'dossier-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users upload own dossier media" on storage.objects;
create policy "Users upload own dossier media" on storage.objects for insert to authenticated
  with check (bucket_id = 'dossier-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users update own dossier media" on storage.objects;
create policy "Users update own dossier media" on storage.objects for update to authenticated
  using (bucket_id = 'dossier-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users delete own dossier media" on storage.objects;
create policy "Users delete own dossier media" on storage.objects for delete to authenticated
  using (bucket_id = 'dossier-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
