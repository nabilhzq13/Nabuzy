-- Dayline, in your own Supabase project.
-- Paste all of this into the SQL Editor and press Run. Running it again is safe.
--
-- One private table for Dayline's pieces (timetable, ticks, assignments, your
-- day, prayers, reminder choices) and one private store for attached files.
-- Row level security lets each account read and write only its own.

create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null,
  value jsonb not null check (pg_column_size(value) < 2000000),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.docs drop constraint if exists docs_key_check;
alter table public.docs add constraint docs_key_check
  check (key in ('blocks', 'done', 'tasks', 'prefs', 'solat', 'solatSet', 'qadhaOld', 'reminders'));
alter table public.docs enable row level security;

drop policy if exists "Owners read their docs" on public.docs;
create policy "Owners read their docs" on public.docs
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Owners add their docs" on public.docs;
create policy "Owners add their docs" on public.docs
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Owners change their docs" on public.docs;
create policy "Owners change their docs" on public.docs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Owners remove their docs" on public.docs;
create policy "Owners remove their docs" on public.docs
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Saving goes through put_doc, and whichever copy changed last wins, so a
-- phone that was offline can't overwrite a newer copy from another phone.
create or replace function public.put_doc(p_key text, p_value jsonb, p_at timestamptz)
returns timestamptz
language sql
set search_path = ''
as $$
  insert into public.docs as d (user_id, key, value, updated_at)
  values ((select auth.uid()), p_key, p_value, p_at)
  on conflict (user_id, key) do update
    set value = excluded.value, updated_at = excluded.updated_at
    where d.updated_at < excluded.updated_at
  returning d.updated_at;
$$;
revoke all on function public.put_doc(text, jsonb, timestamptz) from public, anon;
grant execute on function public.put_doc(text, jsonb, timestamptz) to authenticated;

-- Attached files: <account id>/<file id> in a private store, up to 10 MB each.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists "Owners read their files" on storage.objects;
create policy "Owners read their files" on storage.objects
  for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Owners add their files" on storage.objects;
create policy "Owners add their files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Owners change their files" on storage.objects;
create policy "Owners change their files" on storage.objects
  for update to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Owners remove their files" on storage.objects;
create policy "Owners remove their files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
