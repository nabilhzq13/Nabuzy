-- What Nabuzy added to the project, on top of setup.sql and reminders.sql.
-- Applied on 30 October 2026; running it again is safe.

-- Climbing sessions sync as their own piece.
alter table public.docs drop constraint if exists docs_key_check;
alter table public.docs add constraint docs_key_check
  check (key in ('blocks', 'done', 'tasks', 'prefs', 'solat', 'solatSet', 'qadhaOld', 'reminders', 'climbs'));

-- The reminders' signing key. Only the remind function reads it, with the
-- secret key; nobody signed in, and nobody signed out, can see the table.
-- The key pair itself was made outside this file and inserted once:
--   insert into public.push_vapid (public_key, private_key) values ('<public>', '<private>');
-- The public half is VAPID in index.html. The private half is never written
-- anywhere but this table.
create table if not exists public.push_vapid (
  id smallint primary key default 1 check (id = 1),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
  private_key text not null check (private_key ~ '^[A-Za-z0-9_-]{40,50}$'),
  made_at timestamptz not null default now()
);
alter table public.push_vapid enable row level security;
revoke all on public.push_vapid from anon, authenticated;
comment on table public.push_vapid is 'Nabuzy reminders: the VAPID key pair the remind function signs with. Read by the function only.';
