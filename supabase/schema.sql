-- Supertax Practice Desk: database schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what is missing and replaces policies/functions.

create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('master', 'manager', 'staff');
exception when duplicate_object then null; end $$;

-- People who can sign in. One row per Supabase auth user.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  title text not null default '',
  role public.app_role not null default 'staff',
  active boolean not null default true,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);

-- Who each staff member reports to (their manager). Set by the master admin.
alter table public.profiles add column if not exists reports_to uuid references public.profiles (id) on delete set null;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  entity text not null default 'Company',
  abn text not null default '',
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  manager_id uuid references public.profiles (id) on delete set null,
  services text[] not null default '{}',
  bas_freq text not null default 'quarterly' check (bas_freq in ('quarterly', 'monthly')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  service text not null,
  period text not null check (length(trim(period)) > 0),
  due_date date,
  assignee_id uuid references public.profiles (id) on delete set null,
  reviewer_id uuid references public.profiles (id) on delete set null,
  status text not null default 'not_started'
    check (status in ('not_started', 'waiting', 'in_progress', 'review', 'to_lodge', 'lodged', 'done')),
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  notes text not null default '',
  lodged_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  unique (client_id, service, period)
);

create index if not exists jobs_due_idx on public.jobs (due_date);
create index if not exists jobs_status_idx on public.jobs (status);
create index if not exists jobs_assignee_idx on public.jobs (assignee_id);

-- Stamp who changed a row and when.
create or replace function public.stamp_update() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

drop trigger if exists clients_stamp on public.clients;
create trigger clients_stamp before insert or update on public.clients
  for each row execute function public.stamp_update();
drop trigger if exists jobs_stamp on public.jobs;
create trigger jobs_stamp before insert or update on public.jobs
  for each row execute function public.stamp_update();

-- Helpers used by the access rules. SECURITY DEFINER so they can read profiles
-- without tripping the profiles policy itself.
create or replace function public.is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active;
$$;

-- Row level security: nobody reads or writes anything unless they are an
-- active team member. Creating people and changing roles happens only on the
-- server with the service role key, after checking the caller is the master admin.
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.jobs enable row level security;

-- Full team details (email, role, access): the master admin sees everyone,
-- a manager sees themselves and the people who report to them, staff see only themselves.
drop policy if exists "members read team" on public.profiles;
create policy "members read team" on public.profiles
  for select to authenticated using (
    public.is_active_member() and (
      id = auth.uid()
      or public.my_role() = 'master'
      or (public.my_role() = 'manager' and reports_to = auth.uid())
    )
  );

-- Names only, so everyone can see who a job is assigned to and pick people
-- in the job and client forms. No emails, roles or access status.
create or replace function public.team_directory()
returns table (id uuid, full_name text, title text, active boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.title, p.active from public.profiles p
  where public.is_active_member()
  order by p.full_name;
$$;
revoke all on function public.team_directory() from public, anon;
grant execute on function public.team_directory() to authenticated;

drop policy if exists "people update own name" on public.profiles;
create policy "people update own name" on public.profiles
  for update to authenticated using (id = auth.uid() and public.is_active_member())
  with check (id = auth.uid());

-- Signed-in people may change only their own name and the change-password flag.
revoke insert, update, delete on public.profiles from authenticated, anon;
grant update (full_name, must_change_password) on public.profiles to authenticated;

drop policy if exists "members read clients" on public.clients;
create policy "members read clients" on public.clients
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add clients" on public.clients;
create policy "members add clients" on public.clients
  for insert to authenticated with check (public.is_active_member());
drop policy if exists "members edit clients" on public.clients;
create policy "members edit clients" on public.clients
  for update to authenticated using (public.is_active_member()) with check (public.is_active_member());
drop policy if exists "managers delete clients" on public.clients;
create policy "managers delete clients" on public.clients
  for delete to authenticated using (public.my_role() in ('master', 'manager'));

drop policy if exists "members read jobs" on public.jobs;
create policy "members read jobs" on public.jobs
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add jobs" on public.jobs;
create policy "members add jobs" on public.jobs
  for insert to authenticated with check (public.is_active_member());
drop policy if exists "members edit jobs" on public.jobs;
create policy "members edit jobs" on public.jobs
  for update to authenticated using (public.is_active_member()) with check (public.is_active_member());
drop policy if exists "managers delete jobs" on public.jobs;
create policy "managers delete jobs" on public.jobs
  for delete to authenticated using (public.my_role() in ('master', 'manager'));

revoke all on public.clients, public.jobs from anon;
revoke all on public.profiles from anon;

-- Live updates: everyone's screen refreshes when someone changes a job.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.jobs; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.clients; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
  end if;
end $$;
