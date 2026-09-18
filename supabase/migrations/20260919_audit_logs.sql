create table if not exists public.audit_logs (
 id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id) on delete set null,
 action text not null, entity text not null, entity_id uuid, details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
create policy "Admins read audit logs" on public.audit_logs for select to authenticated using (exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin' and not blocked and not must_change_password));
create or replace function public.log_data_change() returns trigger language plpgsql security definer set search_path = public as $$
declare row_data jsonb; object_id uuid; details jsonb;
begin
 row_data := case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end; object_id := (row_data->>'id')::uuid;
 details := jsonb_build_object('title', row_data->>'title', 'published', row_data->>'published', 'done', row_data->>'done');
 insert into public.audit_logs(actor_id, action, entity, entity_id, details) values (auth.uid(), lower(TG_OP), TG_TABLE_NAME, object_id, details);
 return case when TG_OP='DELETE' then old else new end;
end; $$;
drop trigger if exists todos_audit_log on public.todos;
create trigger todos_audit_log after insert or update or delete on public.todos for each row execute function public.log_data_change();
drop trigger if exists articles_audit_log on public.articles;
create trigger articles_audit_log after insert or update or delete on public.articles for each row execute function public.log_data_change();
create index if not exists audit_logs_recent on public.audit_logs(created_at desc);
create or replace function public.record_client_error(error_message text, error_context text default '') returns void language plpgsql security definer set search_path = public as $$
begin
 insert into public.audit_logs(actor_id, action, entity, details) values (auth.uid(), 'error', 'client', jsonb_build_object('message', left(coalesce(error_message,''),500), 'context', left(coalesce(error_context,''),120)));
end; $$;
revoke all on function public.record_client_error(text,text) from public;
grant execute on function public.record_client_error(text,text) to authenticated;
