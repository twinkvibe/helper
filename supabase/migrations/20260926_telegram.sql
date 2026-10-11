-- Telegram-бот: привязка чата к владельцу и короткая история диалога с ИИ.
-- Один пользователь — один чат. Код привязки одноразовый, живёт 10 минут,
-- хранится только sha256-хэш. История нужна, чтобы ИИ помнил контекст беседы.
-- Всё owner-only: бот работает через service_role, интерфейс — через RLS.
-- Идемпотентная миграция: безопасна к повторному запуску.

create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id bigint unique,
  code_hash text,
  code_expires timestamptz,
  created_at timestamptz not null default now()
);
alter table public.telegram_links enable row level security;
revoke all on public.telegram_links from anon, authenticated;
grant select, insert, update, delete on public.telegram_links to authenticated;
drop policy if exists "Active users manage own telegram link" on public.telegram_links;
create policy "Active users manage own telegram link" on public.telegram_links for all to authenticated
  using(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password))
  with check(user_id = (select auth.uid()) and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password));

create table if not exists public.telegram_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id bigint not null,
  role text not null check(role in ('user', 'assistant')),
  text text not null check(char_length(text) <= 4000),
  created_at timestamptz not null default now()
);
alter table public.telegram_history enable row level security;
revoke all on public.telegram_history from anon, authenticated;
grant select, insert, update, delete on public.telegram_history to authenticated;
drop policy if exists "Active users manage own telegram history" on public.telegram_history;
create policy "Active users manage own telegram history" on public.telegram_history for all to authenticated
  using(
    user_id = (select auth.uid())
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
    and exists(select 1 from public.telegram_links l where l.user_id = (select auth.uid()) and l.chat_id = telegram_history.chat_id)
  )
  with check(
    user_id = (select auth.uid())
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
    and exists(select 1 from public.telegram_links l where l.user_id = (select auth.uid()) and l.chat_id = telegram_history.chat_id)
  );
create index if not exists telegram_history_chat on public.telegram_history(chat_id, id desc);
create index if not exists telegram_history_user on public.telegram_history(user_id, created_at desc);
