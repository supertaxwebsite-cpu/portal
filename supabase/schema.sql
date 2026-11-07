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
-- Staff can be given permission to delete clients and jobs by the master admin or their manager.
alter table public.profiles add column if not exists can_delete boolean not null default false;

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

-- Master admin and managers can always delete; staff only if given delete access.
create or replace function public.can_delete_data() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active
                 and (role in ('master', 'manager') or can_delete));
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
  for delete to authenticated using (public.can_delete_data());

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
  for delete to authenticated using (public.can_delete_data());

revoke all on public.clients, public.jobs from anon;

-- Bulk client import (Clients → Import from CSV or Excel). Only the master admin
-- and managers. All rows are added together, or none if any row fails.
create or replace function public.import_clients(rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(public.my_role()::text, '') not in ('master', 'manager') then
    raise exception 'Only the master admin or a manager can import clients' using errcode = '42501';
  end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then
    raise exception 'Nothing to import';
  end if;
  if jsonb_array_length(rows) > 5000 then
    raise exception 'Import at most 5000 clients at a time';
  end if;
  insert into public.clients (name, entity, abn, contact, email, phone, manager_id, services, bas_freq, notes)
  select trim(r.name), coalesce(nullif(trim(r.entity), ''), 'Company'), coalesce(r.abn, ''), coalesce(r.contact, ''),
         coalesce(r.email, ''), coalesce(r.phone, ''), r.manager_id, coalesce(r.services, '{}'),
         coalesce(nullif(r.bas_freq, ''), 'quarterly'), coalesce(r.notes, '')
  from jsonb_to_recordset(rows) as r(name text, entity text, abn text, contact text, email text, phone text,
                                     manager_id uuid, services text[], bas_freq text, notes text);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.import_clients(jsonb) from public, anon;
grant execute on function public.import_clients(jsonb) to authenticated;

revoke all on public.profiles from anon;

-- Live updates: everyone's screen refreshes when someone changes a job.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.jobs; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.clients; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
  end if;
end $$;

-- ===== Clock in / clock out and daily timesheets =====
-- Everyone records their own. The master admin sees everyone's; a manager sees
-- their own and their team's; staff see only their own.
create or replace function public.can_view_person(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active_member() and (
    target = auth.uid()
    or public.my_role() = 'master'
    or (public.my_role() = 'manager' and exists (select 1 from public.profiles where id = target and reports_to = auth.uid()))
  );
$$;

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  work_date date not null,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  check (clock_out is null or clock_out >= clock_in)
);
create index if not exists attendance_user_date_idx on public.attendance (user_id, work_date);

create table if not exists public.timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  work_date date not null,
  client_id uuid references public.clients (id) on delete set null,
  job_id uuid references public.jobs (id) on delete set null,
  hours numeric(4, 2) not null check (hours > 0 and hours <= 24),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists timesheet_user_date_idx on public.timesheet_entries (user_id, work_date);

alter table public.attendance enable row level security;
alter table public.timesheet_entries enable row level security;

drop policy if exists "see own or team attendance" on public.attendance;
create policy "see own or team attendance" on public.attendance
  for select to authenticated using (public.can_view_person(user_id));
-- Clock times come from the server clock only, through clock_in() and clock_out().
revoke insert, update, delete on public.attendance from authenticated, anon;

drop policy if exists "see own or team timesheets" on public.timesheet_entries;
create policy "see own or team timesheets" on public.timesheet_entries
  for select to authenticated using (public.can_view_person(user_id));
drop policy if exists "add own timesheet" on public.timesheet_entries;
create policy "add own timesheet" on public.timesheet_entries
  for insert to authenticated with check (user_id = auth.uid() and public.is_active_member());
drop policy if exists "edit own timesheet" on public.timesheet_entries;
create policy "edit own timesheet" on public.timesheet_entries
  for update to authenticated using (user_id = auth.uid() and public.is_active_member()) with check (user_id = auth.uid());
drop policy if exists "delete own timesheet" on public.timesheet_entries;
create policy "delete own timesheet" on public.timesheet_entries
  for delete to authenticated using (user_id = auth.uid() and public.is_active_member());
revoke all on public.attendance, public.timesheet_entries from anon;

drop trigger if exists timesheet_stamp on public.timesheet_entries;
create or replace function public.stamp_timesheet() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger timesheet_stamp before update on public.timesheet_entries
  for each row execute function public.stamp_timesheet();

create or replace function public.clock_in() returns public.attendance
language plpgsql security definer set search_path = public as $$
declare r public.attendance;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into r from public.attendance where user_id = auth.uid() and clock_out is null order by clock_in desc limit 1;
  if found then return r; end if;
  insert into public.attendance (user_id, work_date)
  values (auth.uid(), (now() at time zone 'Australia/Sydney')::date) returning * into r;
  return r;
end $$;

create or replace function public.clock_out() returns public.attendance
language plpgsql security definer set search_path = public as $$
declare r public.attendance;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into r from public.attendance where user_id = auth.uid() and clock_out is null order by clock_in desc limit 1;
  if not found then raise exception 'You are not clocked in'; end if;
  if not exists (select 1 from public.timesheet_entries where user_id = auth.uid() and work_date = r.work_date) then
    raise exception 'Fill in your timesheet for % before you clock out', to_char(r.work_date, 'FMDD Mon YYYY');
  end if;
  update public.attendance set clock_out = now() where id = r.id returning * into r;
  return r;
end $$;
revoke all on function public.clock_in(), public.clock_out(), public.can_view_person(uuid) from public, anon;
grant execute on function public.clock_in(), public.clock_out(), public.can_view_person(uuid) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.attendance; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.timesheet_entries; exception when duplicate_object then null; end;
  end if;
end $$;

-- ===== Automatic payroll jobs =====
-- For clients with the Payroll service and a pay frequency, a payroll job is
-- created for each pay date up to 7 days ahead. Runs every morning (pg_cron),
-- whenever a client is saved, and when anyone opens the portal. Never duplicates.
alter table public.clients add column if not exists payroll_freq text not null default '';
alter table public.clients add column if not exists payroll_anchor date;
do $$ begin
  alter table public.clients add constraint clients_payroll_freq_check check (payroll_freq in ('', 'weekly', 'fortnightly', 'monthly'));
exception when duplicate_object then null; end $$;

create or replace function public.generate_payroll_jobs(lead_days integer default 7) returns integer
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  n integer;
begin
  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'payroll',
         case when c.payroll_freq = 'monthly' then to_char(x.d, 'Mon YYYY') else 'Pay ' || to_char(x.d, 'FMDD Mon YYYY') end,
         x.d, c.manager_id
  from public.clients c
  cross join lateral (select g::date as d from generate_series(today, today + least(greatest(lead_days, 0), 31), interval '1 day') g) x
  where 'payroll' = any (c.services)
    and c.payroll_anchor is not null
    and x.d >= c.payroll_anchor
    and case c.payroll_freq
      when 'weekly' then (x.d - c.payroll_anchor) % 7 = 0
      when 'fortnightly' then (x.d - c.payroll_anchor) % 14 = 0
      when 'monthly' then extract(day from x.d) = least(extract(day from c.payroll_anchor),
                          extract(day from (date_trunc('month', x.d) + interval '1 month - 1 day')))
      else false
    end
  on conflict (client_id, service, period) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.generate_payroll_jobs(integer) from public, anon;
grant execute on function public.generate_payroll_jobs(integer) to authenticated;

create or replace function public.payroll_jobs_after_client_change() returns trigger
language plpgsql as $$ begin perform public.generate_payroll_jobs(); return null; end $$;
drop trigger if exists clients_payroll_jobs on public.clients;
create trigger clients_payroll_jobs after insert or update of services, payroll_freq, payroll_anchor on public.clients
  for each statement execute function public.payroll_jobs_after_client_change();

-- Daily at about 6–7am Sydney time. Skipped quietly if pg_cron isn't available;
-- the portal still creates the jobs whenever someone opens it.
do $$ begin
  create extension if not exists pg_cron;
exception when others then raise notice 'pg_cron not available: %', sqlerrm; end $$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('supertax-payroll-jobs', '0 20 * * *', 'select public.generate_payroll_jobs()');
  end if;
end $$;

-- ===== Lock previous days' timesheets =====
-- Entries can be added, changed or removed only for today (Sydney time), or for
-- the day of a shift you're still clocked in to. The master admin can still edit
-- their own past entries.
create or replace function public.timesheet_day_open(d date) returns boolean
language sql stable security definer set search_path = public as $$
  select d >= (now() at time zone 'Australia/Sydney')::date
      or public.my_role() = 'master'
      or exists (select 1 from public.attendance where user_id = auth.uid() and work_date = d and clock_out is null);
$$;
revoke all on function public.timesheet_day_open(date) from public, anon;
grant execute on function public.timesheet_day_open(date) to authenticated;

drop policy if exists "add own timesheet" on public.timesheet_entries;
create policy "add own timesheet" on public.timesheet_entries
  for insert to authenticated with check (user_id = auth.uid() and public.is_active_member() and public.timesheet_day_open(work_date));
drop policy if exists "edit own timesheet" on public.timesheet_entries;
create policy "edit own timesheet" on public.timesheet_entries
  for update to authenticated using (user_id = auth.uid() and public.is_active_member() and public.timesheet_day_open(work_date))
  with check (user_id = auth.uid() and public.timesheet_day_open(work_date));
drop policy if exists "delete own timesheet" on public.timesheet_entries;
create policy "delete own timesheet" on public.timesheet_entries
  for delete to authenticated using (user_id = auth.uid() and public.is_active_member() and public.timesheet_day_open(work_date));

-- ===== Attendance status changes and late approvals =====
-- The master admin can set a day's status by hand (overrides Leave / Half day).
create table if not exists public.attendance_overrides (
  user_id uuid not null references public.profiles (id) on delete cascade,
  work_date date not null,
  status text not null check (status in ('present', 'leave', 'half_day')),
  note text not null default '',
  set_by uuid references public.profiles (id) on delete set null default auth.uid(),
  set_at timestamptz not null default now(),
  primary key (user_id, work_date)
);
-- Staff ask for a late log-in to be approved; the master admin approves or rejects it.
create table if not exists public.late_requests (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  work_date date not null,
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, work_date)
);
alter table public.attendance_overrides enable row level security;
alter table public.late_requests enable row level security;
revoke all on public.attendance_overrides, public.late_requests from anon;

drop policy if exists "see overrides" on public.attendance_overrides;
create policy "see overrides" on public.attendance_overrides for select to authenticated using (public.can_view_person(user_id));
drop policy if exists "master sets overrides" on public.attendance_overrides;
create policy "master sets overrides" on public.attendance_overrides for all to authenticated
  using (public.my_role() = 'master') with check (public.my_role() = 'master');

drop policy if exists "see late requests" on public.late_requests;
create policy "see late requests" on public.late_requests for select to authenticated using (public.can_view_person(user_id));
drop policy if exists "ask own late approval" on public.late_requests;
create policy "ask own late approval" on public.late_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and decided_by is null and public.is_active_member());
drop policy if exists "withdraw own pending request" on public.late_requests;
create policy "withdraw own pending request" on public.late_requests for delete to authenticated
  using ((user_id = auth.uid() and status = 'pending') or public.my_role() = 'master');
drop policy if exists "master decides late requests" on public.late_requests;
create policy "master decides late requests" on public.late_requests for update to authenticated
  using (public.my_role() = 'master') with check (public.my_role() = 'master');

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.attendance_overrides; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.late_requests; exception when duplicate_object then null; end;
  end if;
end $$;

-- ===== Automatic BAS jobs, and payroll jobs on the pay day =====
-- Quarterly BAS clients get "Qn FYyy" once the quarter has ended (e.g. Q2 on
-- 1 January); monthly BAS clients get "Mon YYYY" once the month has ended. Due dates follow the ATO
-- tax agent lodgment program. Payroll jobs are created on the pay day itself.
create or replace function public.generate_bas_jobs() returns integer
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  -- The BAS job for a period appears once that period has ended.
  q_end date := (date_trunc('quarter', today) - interval '1 day')::date;
  m_end date := (date_trunc('month', today) - interval '1 day')::date;
  m int := extract(month from q_end)::int;
  fy int := case when m >= 7 then extract(year from q_end)::int + 1 else extract(year from q_end)::int end;
  q int := case when m between 7 and 9 then 1 when m between 10 and 12 then 2 when m between 1 and 3 then 3 else 4 end;
  q_due date := case q when 1 then make_date(fy - 1, 11, 25) when 2 then make_date(fy, 2, 28) when 3 then make_date(fy, 5, 26) else make_date(fy, 8, 25) end;
  n1 int; n2 int;
begin
  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', 'Q' || q || ' FY' || right(fy::text, 2), q_due, c.manager_id
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'quarterly'
    and today - q_end <= 31  -- only a quarter that has just ended; older quarters aren't back-filled
  on conflict (client_id, service, period) do nothing;
  get diagnostics n1 = row_count;

  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', to_char(m_end, 'Mon YYYY'), (m_end + interval '21 days')::date, c.manager_id
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'monthly'
  on conflict (client_id, service, period) do nothing;
  get diagnostics n2 = row_count;
  return n1 + n2;
end $$;
revoke all on function public.generate_bas_jobs() from public, anon;

-- Payroll and BAS together. Runs daily, when a client is saved, and when the portal opens.
create or replace function public.generate_recurring_jobs() returns integer
language plpgsql security definer set search_path = public as $$
begin
  return public.generate_payroll_jobs(0) + public.generate_bas_jobs();
end $$;
revoke all on function public.generate_recurring_jobs() from public, anon;
grant execute on function public.generate_recurring_jobs() to authenticated;

create or replace function public.payroll_jobs_after_client_change() returns trigger
language plpgsql set search_path = public as $$ begin perform public.generate_recurring_jobs(); return null; end $$;
drop trigger if exists clients_payroll_jobs on public.clients;
create trigger clients_payroll_jobs after insert or update of services, payroll_freq, payroll_anchor, bas_freq on public.clients
  for each statement execute function public.payroll_jobs_after_client_change();

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('supertax-payroll-jobs', '5 13 * * *', 'select public.generate_recurring_jobs()');
  end if;
end $$;
