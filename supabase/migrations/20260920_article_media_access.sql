alter table public.profiles add column if not exists avatar_url text check (avatar_url is null or avatar_url ~ '^https://');
alter table public.articles add column if not exists access text not null default 'private' check (access in ('public','unlisted','private'));
alter table public.articles add column if not exists author_avatar_url text;
update public.articles set access = case when published then 'public' else 'private' end where access = 'private' and published;
update public.articles set published = (access <> 'private');
drop policy if exists "Anyone reads published articles" on public.articles;
create policy "Anyone reads public or unlisted articles" on public.articles for select using (access in ('public','unlisted'));
create or replace function public.set_article_author_name() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select username, avatar_url into new.author_name, new.author_avatar_url from public.profiles where id = new.user_id;
  return new;
end; $$;
drop trigger if exists articles_author_name on public.articles;
create trigger articles_author_name before insert or update on public.articles for each row execute function public.set_article_author_name();
insert into storage.buckets (id, name, public) values ('article-media', 'article-media', true) on conflict (id) do update set public = true;
drop policy if exists "Public reads article media" on storage.objects;
create policy "Public reads article media" on storage.objects for select using (bucket_id = 'article-media');
drop policy if exists "Users upload own article media" on storage.objects;
create policy "Users upload own article media" on storage.objects for insert to authenticated with check (bucket_id = 'article-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users update own article media" on storage.objects;
create policy "Users update own article media" on storage.objects for update to authenticated using (bucket_id = 'article-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users delete own article media" on storage.objects;
create policy "Users delete own article media" on storage.objects for delete to authenticated using (bucket_id = 'article-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create or replace function public.set_profile_avatar(avatar text) returns void language plpgsql security definer set search_path = public as $$
begin
  if avatar is not null and avatar !~ '^https://' then raise exception 'Некорректный URL аватарки'; end if;
  update public.profiles set avatar_url=avatar where id=auth.uid();
end; $$;
revoke all on function public.set_profile_avatar(text) from public;
grant execute on function public.set_profile_avatar(text) to authenticated;
