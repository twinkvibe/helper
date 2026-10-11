-- Досье: профиль человека становится полноценной карточкой.
-- avatar_path — объект в приватном бакете dossier-media (<uid>/avatars/…),
-- показывается только владельцу по подписанной ссылке.
-- relationship — статус отношений глазами владельца («друзья», «натянутые»…).
-- facts — известные факты списком [{key, value}] (адрес, телефон, день рождения…).
-- dossier_person_links — ссылки человека на других людей с подписью.
-- Идемпотентная миграция: безопасна к повторному запуску.

alter table public.dossier_people
  add column if not exists avatar_path text;
alter table public.dossier_people
  add column if not exists relationship text not null default ''
  check (char_length(relationship) <= 120);
alter table public.dossier_people
  add column if not exists facts jsonb not null default '[]'::jsonb
  check (jsonb_typeof(facts) = 'array');

create table if not exists public.dossier_person_links (
  person_id uuid not null references public.dossier_people(id) on delete cascade,
  linked_person_id uuid not null references public.dossier_people(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label text not null default '' check(char_length(label) <= 120),
  created_at timestamptz not null default now(),
  primary key (person_id, linked_person_id),
  check (person_id <> linked_person_id)
);
alter table public.dossier_person_links enable row level security;
revoke all on public.dossier_person_links from anon, authenticated;
grant select, insert, update, delete on public.dossier_person_links to authenticated;
drop policy if exists "Active users manage own dossier person links" on public.dossier_person_links;
create policy "Active users manage own dossier person links" on public.dossier_person_links for all to authenticated
  using(
    user_id = (select auth.uid())
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
    and exists(select 1 from public.dossier_people p where p.id = person_id and p.user_id = (select auth.uid()))
    and exists(select 1 from public.dossier_people p where p.id = linked_person_id and p.user_id = (select auth.uid()))
  )
  with check(
    user_id = (select auth.uid())
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
    and exists(select 1 from public.dossier_people p where p.id = person_id and p.user_id = (select auth.uid()))
    and exists(select 1 from public.dossier_people p where p.id = linked_person_id and p.user_id = (select auth.uid()))
  );
create index if not exists dossier_person_link_owner on public.dossier_person_links(user_id, person_id);
create index if not exists dossier_person_link_target on public.dossier_person_links(linked_person_id);
