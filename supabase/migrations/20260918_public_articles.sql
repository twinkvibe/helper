-- Public reading is deliberately limited to published articles; authors retain ownership.
create table if not exists public.articles (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check (char_length(trim(title)) between 1 and 180),
 slug text not null unique check (slug ~ '^[a-z0-9а-яё-]{1,80}$'),
 body text not null default '' check (char_length(body) <= 5000000),
 excerpt text not null default '' check (char_length(excerpt) <= 220),
 cover_url text,
 author_name text not null check (char_length(author_name) between 3 and 32),
 published boolean not null default false,
 published_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check ((published and published_at is not null) or (not published and published_at is null)),
 check (cover_url is null or cover_url ~ '^https://')
);
alter table public.articles enable row level security;
revoke all on public.articles from anon, authenticated;
grant select on public.articles to anon, authenticated;
grant insert, update, delete on public.articles to authenticated;
create policy "Anyone reads published articles" on public.articles for select using (published = true);
create policy "Active users manage own articles" on public.articles for all to authenticated
 using (user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
 with check (user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));
create index if not exists articles_public_recent on public.articles (published_at desc) where published;
create index if not exists articles_owner_recent on public.articles (user_id, updated_at desc);
create or replace function public.set_article_author_name() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select username into new.author_name from public.profiles where id = new.user_id;
  return new;
end; $$;
drop trigger if exists articles_author_name on public.articles;
create trigger articles_author_name before insert or update on public.articles for each row execute function public.set_article_author_name();
