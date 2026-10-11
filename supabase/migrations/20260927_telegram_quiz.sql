-- Telegram-опросники: ожидание свободного ответа (кнопка «Свой вариант»).
-- Одна строка на чат: какой вопрос ждёт текст и куда его деть.
-- Всё owner-only через связку с telegram_links; бот ходит через service_role.
-- Идемпотентная миграция: безопасна к повторному запуску.

create table if not exists public.telegram_pending (
  chat_id bigint primary key,
  kind text not null default 'quiz' check(char_length(kind) <= 40),
  qid text not null default '' check(char_length(qid) <= 40),
  message_id bigint not null default 0,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.telegram_pending enable row level security;
revoke all on public.telegram_pending from anon, authenticated;
grant select, insert, update, delete on public.telegram_pending to authenticated;
drop policy if exists "Active users manage own telegram pending" on public.telegram_pending;
create policy "Active users manage own telegram pending" on public.telegram_pending for all to authenticated
  using(
    exists(select 1 from public.telegram_links l where l.user_id = (select auth.uid()) and l.chat_id = telegram_pending.chat_id)
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
  )
  with check(
    exists(select 1 from public.telegram_links l where l.user_id = (select auth.uid()) and l.chat_id = telegram_pending.chat_id)
    and exists(select 1 from public.profiles where id = (select auth.uid()) and not blocked and not must_change_password)
  );
create index if not exists telegram_pending_recent on public.telegram_pending(created_at desc);
