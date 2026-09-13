-- Run once in SQL Editor on an existing helper project. Existing tasks are preserved.
begin;
alter table public.todos
 add column if not exists description text not null default '' check (char_length(description) <= 5000000),
 add column if not exists list_name text not null default 'Входящие' check (char_length(list_name) between 1 and 80),
 add column if not exists due_date date,
 add column if not exists priority integer not null default 0 check (priority between 0 and 2),
 add column if not exists note_id uuid,
 add column if not exists tags text[] not null default '{}' check (cardinality(tags) <= 20);
-- Existing owner + active-profile RLS also covers these columns.
commit;
