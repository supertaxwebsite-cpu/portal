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
    check (status in ('not_started', 'waiting', 'internal_query', 'in_progress', 'review', 'to_lodge', 'lodged', 'done')),
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

-- ===== Job timers: Start / Stop a job from "My jobs"; the time goes to the timesheet =====
create table if not exists public.job_timers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  entry_id uuid references public.timesheet_entries (id) on delete set null
);
-- One running job per person.
create unique index if not exists job_timers_one_running on public.job_timers (user_id) where ended_at is null;
alter table public.job_timers enable row level security;
drop policy if exists "see own or team job timers" on public.job_timers;
create policy "see own or team job timers" on public.job_timers
  for select to authenticated using (public.can_view_person(user_id));
-- Start and stop times come from the server clock only, through start_job() and stop_job().
revoke insert, update, delete on public.job_timers from authenticated;
revoke all on public.job_timers from anon;

-- Ends a person's running timer and adds the time to their timesheet. Internal only.
create or replace function public.end_job_timer(p_uid uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  t public.job_timers;
  j public.jobs;
  tz constant text := 'Australia/Sydney';
  hrs numeric;
  e uuid;
begin
  select * into t from public.job_timers where user_id = p_uid and ended_at is null for update;
  if not found then return null; end if;
  select * into j from public.jobs where id = t.job_id;
  hrs := least(24, greatest(0.01, round((extract(epoch from now() - t.started_at) / 3600)::numeric, 2)));
  insert into public.timesheet_entries (user_id, work_date, client_id, job_id, hours, description)
  values (p_uid, (t.started_at at time zone tz)::date, j.client_id, t.job_id, hrs,
          'Timer ' || lower(to_char(t.started_at at time zone tz, 'FMHH12:MIAM')) || ' to ' || lower(to_char(now() at time zone tz, 'FMHH12:MIAM')))
  returning id into e;
  update public.job_timers set ended_at = now(), entry_id = e where id = t.id;
  return hrs;
end $$;
revoke all on function public.end_job_timer(uuid) from public, anon, authenticated;

-- Start working on one of my jobs. Starting another job stops (and logs) the one running.
create or replace function public.start_job(p_job uuid) returns public.job_timers
language plpgsql security definer set search_path = public as $$
declare j public.jobs; t public.job_timers;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from auth.uid() then raise exception 'You can only start jobs assigned to you'; end if;
  if j.status in ('lodged', 'done') then raise exception 'This job is already finished'; end if;
  select * into t from public.job_timers where user_id = auth.uid() and ended_at is null;
  if found then
    if t.job_id = p_job then return t; end if;
    perform public.end_job_timer(auth.uid());
  end if;
  insert into public.job_timers (user_id, job_id) values (auth.uid(), p_job) returning * into t;
  if j.status in ('not_started', 'waiting', 'internal_query') then
    update public.jobs set status = 'in_progress' where id = p_job;
  end if;
  return t;
end $$;

-- Stop my running job. Returns the hours added to my timesheet.
create or replace function public.stop_job() returns numeric
language plpgsql security definer set search_path = public as $$
declare hrs numeric;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  hrs := public.end_job_timer(auth.uid());
  if hrs is null then raise exception 'No job is running'; end if;
  return hrs;
end $$;
revoke all on function public.start_job(uuid), public.stop_job() from public, anon;
grant execute on function public.start_job(uuid), public.stop_job() to authenticated;

-- Logging out stops a running job first, so its time is on the timesheet.
create or replace function public.clock_out() returns public.attendance
language plpgsql security definer set search_path = public as $$
declare r public.attendance;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into r from public.attendance where user_id = auth.uid() and clock_out is null order by clock_in desc limit 1;
  if not found then raise exception 'You are not clocked in'; end if;
  perform public.end_job_timer(auth.uid());
  if not exists (select 1 from public.timesheet_entries where user_id = auth.uid() and work_date = r.work_date) then
    raise exception 'Fill in your timesheet for % before you clock out', to_char(r.work_date, 'FMDD Mon YYYY');
  end if;
  update public.attendance set clock_out = now() where id = r.id returning * into r;
  return r;
end $$;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.job_timers; exception when duplicate_object then null; end;
  end if;
end $$;

-- ===== Staff can't change a job's set-up =====
-- Staff can update a job's status and notes. Only master admins and managers can change the
-- client, service, period, due date, priority, assignee, reviewer or lodgment date.
create or replace function public.guard_job_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.my_role() is distinct from 'staff' then return new; end if;
  -- Lodgment date: set automatically the first time a job is marked Lodged.
  if new.status = 'lodged' and old.lodged_on is null then
    new.lodged_on := (now() at time zone 'Australia/Sydney')::date;
  else
    new.lodged_on := old.lodged_on;
  end if;
  -- Submitting for review may fill an empty reviewer with the person's own manager.
  if new.reviewer_id is distinct from old.reviewer_id
     and not (old.reviewer_id is null and new.reviewer_id is not distinct from (select reports_to from public.profiles where id = auth.uid())) then
    raise exception 'Only your manager can change the reviewer of a job' using errcode = '42501';
  end if;
  if (new.client_id, new.service, new.period, new.due_date, new.priority, new.assignee_id)
     is distinct from (old.client_id, old.service, old.period, old.due_date, old.priority, old.assignee_id) then
    raise exception 'Only your manager can change the client, service, period, due date, priority or assignee of a job' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_job_fields() from public, anon, authenticated;
drop trigger if exists jobs_guard on public.jobs;
create trigger jobs_guard before update on public.jobs
  for each row execute function public.guard_job_fields();

-- ===== "Internal query" job status (for databases created before it existed) =====
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('not_started', 'waiting', 'internal_query', 'in_progress', 'review', 'to_lodge', 'lodged', 'done'));

-- ===== Internal query: send a job to a team member and get it back =====
-- query_from remembers who sent the job, so it can go back to them.
alter table public.jobs add column if not exists query_from uuid references public.profiles (id) on delete set null;

-- Let the two functions below move a job between people even for staff.
create or replace function public.guard_job_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.my_role() is distinct from 'staff'
     or current_setting('supertax.job_handover', true) = 'on' then return new; end if;
  new.query_from := old.query_from;
  if new.status = 'lodged' and old.lodged_on is null then
    new.lodged_on := (now() at time zone 'Australia/Sydney')::date;
  else
    new.lodged_on := old.lodged_on;
  end if;
  if new.reviewer_id is distinct from old.reviewer_id
     and not (old.reviewer_id is null and new.reviewer_id is not distinct from (select reports_to from public.profiles where id = auth.uid())) then
    raise exception 'Only your manager can change the reviewer of a job' using errcode = '42501';
  end if;
  if (new.client_id, new.service, new.period, new.due_date, new.priority, new.assignee_id)
     is distinct from (old.client_id, old.service, old.period, old.due_date, old.priority, old.assignee_id) then
    raise exception 'Only your manager can change the client, service, period, due date, priority or assignee of a job' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.send_internal_query(p_job uuid, p_to uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from me and public.my_role() not in ('master', 'manager') then
    raise exception 'Only the person working on this job can send it for an internal query' using errcode = '42501';
  end if;
  if p_to is null or p_to = me or not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'Choose another team member to send the query to';
  end if;
  -- Log any time running on this job before it changes hands.
  if exists (select 1 from public.job_timers where user_id = me and job_id = p_job and ended_at is null) then
    perform public.end_job_timer(me);
  end if;
  select full_name into who from public.profiles where id = me;
  perform set_config('supertax.job_handover', 'on', true);
  update public.jobs set
    status = 'internal_query',
    query_from = coalesce(j.query_from, j.assignee_id, me),
    assignee_id = p_to,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both E'\n' from notes || E'\n' || 'Internal query from ' || who || ' (' || to_char(now() at time zone 'Australia/Sydney', 'FMDD Mon') || '): ' || trim(p_note)) end
  where id = p_job;
  perform set_config('supertax.job_handover', 'off', true);
end $$;

create or replace function public.answer_internal_query(p_job uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.query_from is null then raise exception 'This job has no internal query to answer'; end if;
  if j.assignee_id is distinct from me and public.my_role() not in ('master', 'manager') then
    raise exception 'Only the person the query was sent to can send it back' using errcode = '42501';
  end if;
  if exists (select 1 from public.job_timers where user_id = me and job_id = p_job and ended_at is null) then
    perform public.end_job_timer(me);
  end if;
  select full_name into who from public.profiles where id = me;
  perform set_config('supertax.job_handover', 'on', true);
  update public.jobs set
    status = 'in_progress',
    assignee_id = j.query_from,
    query_from = null,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both E'\n' from notes || E'\n' || 'Reply from ' || who || ' (' || to_char(now() at time zone 'Australia/Sydney', 'FMDD Mon') || '): ' || trim(p_note)) end
  where id = p_job;
  perform set_config('supertax.job_handover', 'off', true);
end $$;
revoke all on function public.send_internal_query(uuid, uuid, text), public.answer_internal_query(uuid, text) from public, anon;
grant execute on function public.send_internal_query(uuid, uuid, text), public.answer_internal_query(uuid, text) to authenticated;

-- Starting a job under internal query keeps it as Internal query; the timer note says so.
create or replace function public.start_job(p_job uuid) returns public.job_timers
language plpgsql security definer set search_path = public as $$
declare j public.jobs; t public.job_timers;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from auth.uid() then raise exception 'You can only start jobs assigned to you'; end if;
  if j.status in ('lodged', 'done') then raise exception 'This job is already finished'; end if;
  select * into t from public.job_timers where user_id = auth.uid() and ended_at is null;
  if found then
    if t.job_id = p_job then return t; end if;
    perform public.end_job_timer(auth.uid());
  end if;
  insert into public.job_timers (user_id, job_id) values (auth.uid(), p_job) returning * into t;
  if j.status in ('not_started', 'waiting') then
    update public.jobs set status = 'in_progress' where id = p_job;
  end if;
  return t;
end $$;

create or replace function public.end_job_timer(p_uid uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  t public.job_timers;
  j public.jobs;
  tz constant text := 'Australia/Sydney';
  hrs numeric;
  e uuid;
begin
  select * into t from public.job_timers where user_id = p_uid and ended_at is null for update;
  if not found then return null; end if;
  select * into j from public.jobs where id = t.job_id;
  hrs := least(24, greatest(0.01, round((extract(epoch from now() - t.started_at) / 3600)::numeric, 2)));
  insert into public.timesheet_entries (user_id, work_date, client_id, job_id, hours, description)
  values (p_uid, (t.started_at at time zone tz)::date, j.client_id, t.job_id, hrs,
          case when j.status = 'internal_query' and j.assignee_id = p_uid then 'Internal review, timer ' else 'Timer ' end
          || lower(to_char(t.started_at at time zone tz, 'FMHH12:MIAM')) || ' to ' || lower(to_char(now() at time zone tz, 'FMHH12:MIAM')))
  returning id into e;
  update public.job_timers set ended_at = now(), entry_id = e where id = t.id;
  return hrs;
end $$;
revoke all on function public.end_job_timer(uuid) from public, anon, authenticated;

-- ===== "Sent for sign" status before Lodged. Completed is for change requests and admin work. =====
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('not_started', 'waiting', 'internal_query', 'in_progress', 'review', 'to_lodge', 'sent_for_sign', 'lodged', 'done'));

-- ===== Client notes: a dated log of notes on each client, with key notes pinned =====
create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null default auth.uid(),
  category text not null default 'general'
    check (category in ('general', 'software', 'contact', 'tax', 'payroll', 'instruction')),
  body text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_notes_client_idx on public.client_notes (client_id, created_at desc);
alter table public.client_notes enable row level security;
drop policy if exists "members read client notes" on public.client_notes;
create policy "members read client notes" on public.client_notes
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add client notes" on public.client_notes;
create policy "members add client notes" on public.client_notes
  for insert to authenticated with check (public.is_active_member() and author_id = auth.uid());
-- The writer can edit their own note; master admins and managers can edit (or pin) any note.
drop policy if exists "edit own or as manager" on public.client_notes;
create policy "edit own or as manager" on public.client_notes
  for update to authenticated
  using (public.is_active_member() and (author_id = auth.uid() or public.my_role() in ('master', 'manager')))
  with check (public.is_active_member());
-- Same delete rule as clients and jobs.
drop policy if exists "delete with delete access" on public.client_notes;
create policy "delete with delete access" on public.client_notes
  for delete to authenticated using (public.can_delete_data());
revoke all on public.client_notes from anon;

create or replace function public.stamp_client_note() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.author_id := old.author_id;
  new.client_id := old.client_id;
  new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists client_notes_stamp on public.client_notes;
create trigger client_notes_stamp before update on public.client_notes
  for each row execute function public.stamp_client_note();

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.client_notes; exception when duplicate_object then null; end;
  end if;
end $$;

-- ===== Job history: automatic activity log + comments =====
create table if not exists public.job_activity (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null default auth.uid(),
  kind text not null check (kind in ('created', 'status', 'assignee', 'reviewer', 'due', 'comment')),
  from_value text,
  to_value text,
  body text not null default '' check (length(body) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists job_activity_job_idx on public.job_activity (job_id, created_at);
alter table public.job_activity enable row level security;
drop policy if exists "members read job activity" on public.job_activity;
create policy "members read job activity" on public.job_activity
  for select to authenticated using (public.is_active_member());
-- People add comments; everything else is written by the trigger below.
drop policy if exists "members add job comments" on public.job_activity;
create policy "members add job comments" on public.job_activity
  for insert to authenticated with check (public.is_active_member() and kind = 'comment' and actor_id = auth.uid() and length(trim(body)) > 0);
drop policy if exists "delete own comment or with delete access" on public.job_activity;
create policy "delete own comment or with delete access" on public.job_activity
  for delete to authenticated using (kind = 'comment' and (actor_id = auth.uid() or public.can_delete_data()));
revoke update on public.job_activity from authenticated;
revoke all on public.job_activity from anon;

create or replace function public.log_job_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.job_activity (job_id, actor_id, kind, to_value) values (new.id, auth.uid(), 'created', new.status);
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.job_activity (job_id, actor_id, kind, from_value, to_value) values (new.id, auth.uid(), 'status', old.status, new.status);
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into public.job_activity (job_id, actor_id, kind, from_value, to_value) values (new.id, auth.uid(), 'assignee', old.assignee_id::text, new.assignee_id::text);
  end if;
  if new.reviewer_id is distinct from old.reviewer_id then
    insert into public.job_activity (job_id, actor_id, kind, from_value, to_value) values (new.id, auth.uid(), 'reviewer', old.reviewer_id::text, new.reviewer_id::text);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into public.job_activity (job_id, actor_id, kind, from_value, to_value) values (new.id, auth.uid(), 'due', old.due_date::text, new.due_date::text);
  end if;
  return new;
end $$;
revoke all on function public.log_job_activity() from public, anon, authenticated;
drop trigger if exists jobs_activity on public.jobs;
create trigger jobs_activity after insert or update on public.jobs
  for each row execute function public.log_job_activity();

-- Jobs created before the log existed get a "created" entry.
insert into public.job_activity (job_id, actor_id, kind, to_value, created_at)
select j.id, null, 'created', null, j.created_at from public.jobs j
where not exists (select 1 from public.job_activity a where a.job_id = j.id);

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.job_activity; exception when duplicate_object then null; end;
  end if;
end $$;

-- Internal query and reply text also go into the job's comments.
create or replace function public.send_internal_query(p_job uuid, p_to uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from me and public.my_role() not in ('master', 'manager') then
    raise exception 'Only the person working on this job can send it for an internal query' using errcode = '42501';
  end if;
  if p_to is null or p_to = me or not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'Choose another team member to send the query to';
  end if;
  -- Log any time running on this job before it changes hands.
  if exists (select 1 from public.job_timers where user_id = me and job_id = p_job and ended_at is null) then
    perform public.end_job_timer(me);
  end if;
  select full_name into who from public.profiles where id = me;
  perform set_config('supertax.job_handover', 'on', true);
  update public.jobs set
    status = 'internal_query',
    query_from = coalesce(j.query_from, j.assignee_id, me),
    assignee_id = p_to,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both E'\n' from notes || E'\n' || 'Internal query from ' || who || ' (' || to_char(now() at time zone 'Australia/Sydney', 'FMDD Mon') || '): ' || trim(p_note)) end
  where id = p_job;
  perform set_config('supertax.job_handover', 'off', true);
  if coalesce(trim(p_note), '') <> '' then
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'comment', 'Internal query: ' || trim(p_note));
  end if;
end $$;

create or replace function public.answer_internal_query(p_job uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.query_from is null then raise exception 'This job has no internal query to answer'; end if;
  if j.assignee_id is distinct from me and public.my_role() not in ('master', 'manager') then
    raise exception 'Only the person the query was sent to can send it back' using errcode = '42501';
  end if;
  if exists (select 1 from public.job_timers where user_id = me and job_id = p_job and ended_at is null) then
    perform public.end_job_timer(me);
  end if;
  select full_name into who from public.profiles where id = me;
  perform set_config('supertax.job_handover', 'on', true);
  update public.jobs set
    status = 'in_progress',
    assignee_id = j.query_from,
    query_from = null,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both E'\n' from notes || E'\n' || 'Reply from ' || who || ' (' || to_char(now() at time zone 'Australia/Sydney', 'FMDD Mon') || '): ' || trim(p_note)) end
  where id = p_job;
  perform set_config('supertax.job_handover', 'off', true);
  if coalesce(trim(p_note), '') <> '' then
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'comment', 'Reply: ' || trim(p_note));
  end if;
end $$;

-- ===== Lodged and Completed jobs are read-only, except for master admins =====
create or replace function public.job_is_locked(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.my_role() is distinct from 'master'
     and exists (select 1 from public.jobs where id = p_job and status in ('lodged', 'done'));
$$;
revoke all on function public.job_is_locked(uuid) from public, anon;
grant execute on function public.job_is_locked(uuid) to authenticated;

create or replace function public.guard_closed_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.my_role() = 'master' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.status in ('lodged', 'done') then
    raise exception 'This job is % and can only be changed by a master admin', case when old.status = 'lodged' then 'lodged' else 'completed' end
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.guard_closed_job() from public, anon, authenticated;
drop trigger if exists jobs_closed_guard on public.jobs;
create trigger jobs_closed_guard before update or delete on public.jobs
  for each row execute function public.guard_closed_job();

-- No new comments or time on a closed job (a timer that was already running can still stop).
create or replace function public.guard_closed_job_children() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('supertax.timer_stop', true) = 'on' then return new; end if;
  if tg_table_name = 'job_activity' then
    if new.kind <> 'comment' then return new; end if;
  end if;
  if new.job_id is not null and (tg_op = 'INSERT' or new.job_id is distinct from old.job_id) and public.job_is_locked(new.job_id) then
    raise exception 'This job is lodged or completed. Only a master admin can add to it.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_closed_job_children() from public, anon, authenticated;
drop trigger if exists timesheet_closed_job_guard on public.timesheet_entries;
create trigger timesheet_closed_job_guard before insert or update on public.timesheet_entries
  for each row execute function public.guard_closed_job_children();
drop trigger if exists job_activity_closed_guard on public.job_activity;
create trigger job_activity_closed_guard before insert on public.job_activity
  for each row execute function public.guard_closed_job_children();

create or replace function public.end_job_timer(p_uid uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  t public.job_timers;
  j public.jobs;
  tz constant text := 'Australia/Sydney';
  hrs numeric;
  e uuid;
begin
  select * into t from public.job_timers where user_id = p_uid and ended_at is null for update;
  if not found then return null; end if;
  select * into j from public.jobs where id = t.job_id;
  hrs := least(24, greatest(0.01, round((extract(epoch from now() - t.started_at) / 3600)::numeric, 2)));
  perform set_config('supertax.timer_stop', 'on', true);
  insert into public.timesheet_entries (user_id, work_date, client_id, job_id, hours, description)
  values (p_uid, (t.started_at at time zone tz)::date, j.client_id, t.job_id, hrs,
          case when j.status = 'internal_query' and j.assignee_id = p_uid then 'Internal review, timer ' else 'Timer ' end
          || lower(to_char(t.started_at at time zone tz, 'FMHH12:MIAM')) || ' to ' || lower(to_char(now() at time zone tz, 'FMHH12:MIAM')))
  returning id into e;
  perform set_config('supertax.timer_stop', 'off', true);
  update public.job_timers set ended_at = now(), entry_id = e where id = t.id;
  return hrs;
end $$;
revoke all on function public.end_job_timer(uuid) from public, anon, authenticated;

-- ===== Meetings calendar (booked by master admins and managers) =====
create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0 and length(title) <= 200),
  client_id uuid references public.clients (id) on delete set null,
  starts_at timestamptz not null,
  duration_min integer not null default 30 check (duration_min between 5 and 720),
  location text not null default '',
  notes text not null default '',
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  attendees uuid[] not null default '{}',
  remind_min integer not null default 15 check (remind_min between 0 and 10080),
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meetings_starts_idx on public.meetings (starts_at);
alter table public.meetings enable row level security;
drop policy if exists "see own, invited or as master" on public.meetings;
create policy "see own, invited or as master" on public.meetings
  for select to authenticated using (public.is_active_member() and (owner_id = auth.uid() or auth.uid() = any (attendees) or public.my_role() = 'master'));
drop policy if exists "managers book meetings" on public.meetings;
create policy "managers book meetings" on public.meetings
  for insert to authenticated with check (public.is_active_member() and owner_id = auth.uid() and public.my_role() in ('master', 'manager'));
drop policy if exists "owner or master edits meetings" on public.meetings;
create policy "owner or master edits meetings" on public.meetings
  for update to authenticated using (public.is_active_member() and (owner_id = auth.uid() or public.my_role() = 'master'))
  with check (public.is_active_member());
drop policy if exists "owner or master deletes meetings" on public.meetings;
create policy "owner or master deletes meetings" on public.meetings
  for delete to authenticated using (public.is_active_member() and (owner_id = auth.uid() or public.my_role() = 'master'));
revoke all on public.meetings from anon;

create or replace function public.stamp_meeting() returns trigger
language plpgsql as $$ begin new.updated_at := now(); new.owner_id := old.owner_id; return new; end $$;
drop trigger if exists meetings_stamp on public.meetings;
create trigger meetings_stamp before update on public.meetings
  for each row execute function public.stamp_meeting();

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.meetings; exception when duplicate_object then null; end;
  end if;
end $$;

-- ============================================================
-- Notifications (the bell): a note for each person when something is sent to them.
-- Written only by the triggers below; people read and mark their own as read.
-- ============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('job_assigned', 'internal_query', 'query_answered', 'review', 'meeting')),
  job_id uuid references public.jobs (id) on delete cascade,
  meeting_id uuid references public.meetings (id) on delete cascade,
  service text not null default '',
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists "read own notifications" on public.notifications;
create policy "read own notifications" on public.notifications
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "mark own notifications" on public.notifications;
create policy "mark own notifications" on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "clear own notifications" on public.notifications;
create policy "clear own notifications" on public.notifications
  for delete to authenticated using (user_id = auth.uid());
revoke all on public.notifications from anon;
revoke insert, update on public.notifications from authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create or replace function public.notify_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); what text; k text;
begin
  select c.name || ' · ' || new.period into what from public.clients c where c.id = new.client_id;
  if new.assignee_id is not null and new.assignee_id is distinct from me
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    k := case
      when new.status = 'internal_query' and (tg_op = 'INSERT' or old.status is distinct from 'internal_query') then 'internal_query'
      when tg_op = 'UPDATE' and old.status = 'internal_query' and new.status is distinct from 'internal_query' then 'query_answered'
      else 'job_assigned' end;
    insert into public.notifications (user_id, actor_id, kind, job_id, service, body) values (new.assignee_id, me, k, new.id, new.service, coalesce(what, ''));
  end if;
  if tg_op = 'UPDATE' and new.status = 'review' and old.status is distinct from 'review'
     and new.reviewer_id is not null and new.reviewer_id is distinct from me and new.reviewer_id is distinct from new.assignee_id then
    insert into public.notifications (user_id, actor_id, kind, job_id, service, body) values (new.reviewer_id, me, 'review', new.id, new.service, coalesce(what, ''));
  end if;
  return new;
end $$;
revoke all on function public.notify_job() from public, anon, authenticated;
drop trigger if exists jobs_notify on public.jobs;
create trigger jobs_notify after insert or update on public.jobs
  for each row execute function public.notify_job();

create or replace function public.notify_meeting() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  insert into public.notifications (user_id, actor_id, kind, meeting_id, body)
  select distinct a, me, 'meeting', new.id, new.title
  from unnest(new.attendees) a
  where a is distinct from me and a <> new.owner_id
    and (tg_op = 'INSERT' or not (a = any (old.attendees)))
    and exists (select 1 from public.profiles p where p.id = a);
  return new;
end $$;
revoke all on function public.notify_meeting() from public, anon, authenticated;
drop trigger if exists meetings_notify on public.meetings;
create trigger meetings_notify after insert or update of attendees on public.meetings
  for each row execute function public.notify_meeting();

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
  end if;
end $$;

-- ============================================================
-- Only master admins can delete clients and jobs.
-- (Delete access given to staff now covers notes and comments only.)
-- ============================================================
create or replace function public.is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'master');
$$;
revoke all on function public.is_master() from public, anon;
grant execute on function public.is_master() to authenticated;
drop policy if exists "managers delete clients" on public.clients;
drop policy if exists "master deletes clients" on public.clients;
create policy "master deletes clients" on public.clients
  for delete to authenticated using (public.is_master());
drop policy if exists "managers delete jobs" on public.jobs;
drop policy if exists "master deletes jobs" on public.jobs;
create policy "master deletes jobs" on public.jobs
  for delete to authenticated using (public.is_master());

-- ============================================================
-- Team workload / Working now: master admins always; anyone else only if a master admin allows it.
-- ============================================================
alter table public.profiles add column if not exists can_see_workload boolean not null default false;

create or replace function public.can_see_workload() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and (role = 'master' or can_see_workload));
$$;
revoke all on function public.can_see_workload() from public, anon;
grant execute on function public.can_see_workload() to authenticated;

-- People allowed to see Working now can see everyone's running job timers.
drop policy if exists "workload viewers read timers" on public.job_timers;
create policy "workload viewers read timers" on public.job_timers
  for select to authenticated using (ended_at is null and public.can_see_workload());

-- Total hours logged on the given jobs (for Working now), without exposing anyone's timesheet.
create or replace function public.job_hours(p_jobs uuid[]) returns table (job_id uuid, hours numeric)
language sql stable security definer set search_path = public as $$
  select e.job_id, sum(e.hours)::numeric from public.timesheet_entries e
  where public.can_see_workload() and e.job_id = any (p_jobs)
  group by e.job_id;
$$;
revoke all on function public.job_hours(uuid[]) from public, anon;
grant execute on function public.job_hours(uuid[]) to authenticated;

-- ============================================================
-- Payroll sign-off: the preparer submits the pay run, then a team leader or master admin
-- confirms super has been paid, then lodges STP (which marks the job lodged).
-- ============================================================
alter table public.jobs add column if not exists super_done_at timestamptz;
alter table public.jobs add column if not exists super_done_by uuid references public.profiles (id) on delete set null;
alter table public.jobs add column if not exists stp_done_at timestamptz;
alter table public.jobs add column if not exists stp_done_by uuid references public.profiles (id) on delete set null;

alter table public.job_activity drop constraint if exists job_activity_kind_check;
alter table public.job_activity add constraint job_activity_kind_check
  check (kind in ('created', 'status', 'assignee', 'reviewer', 'due', 'comment', 'super', 'stp'));

-- The sign-off columns change only through payroll_step() below.
create or replace function public.guard_payroll_steps() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('supertax.payroll_step', true) = 'on' then return new; end if;
  if (new.super_done_at, new.super_done_by, new.stp_done_at, new.stp_done_by)
     is distinct from (old.super_done_at, old.super_done_by, old.stp_done_at, old.stp_done_by) then
    raise exception 'Use the payroll buttons to confirm super and STP' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_payroll_steps() from public, anon, authenticated;
drop trigger if exists jobs_payroll_guard on public.jobs;
create trigger jobs_payroll_guard before update on public.jobs
  for each row execute function public.guard_payroll_steps();

-- p_step: 'super' (confirm super paid), 'stp' (STP lodged: job becomes lodged), 'undo_super' (take the super tick back).
create or replace function public.payroll_step(p_job uuid, p_step text) returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); r public.app_role := public.my_role();
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.service <> 'payroll' then raise exception 'This is not a payroll job'; end if;
  if r is distinct from 'master' and r is distinct from 'manager' and j.reviewer_id is distinct from me then
    raise exception 'Only a team leader or master admin can sign off payroll' using errcode = '42501';
  end if;
  if j.status in ('lodged', 'done') then raise exception 'This pay run is already finished'; end if;
  perform set_config('supertax.payroll_step', 'on', true);
  if p_step = 'super' then
    if j.super_done_at is not null then return; end if;
    update public.jobs set super_done_at = now(), super_done_by = me,
      status = case when status in ('not_started', 'in_progress', 'waiting') then 'review' else status end
      where id = p_job;
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'super', 'Super confirmed as processed');
  elsif p_step = 'undo_super' then
    update public.jobs set super_done_at = null, super_done_by = null where id = p_job;
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'super', 'Super tick taken back');
  elsif p_step = 'stp' then
    if j.super_done_at is null then raise exception 'Confirm super first, then lodge STP'; end if;
    update public.jobs set stp_done_at = now(), stp_done_by = me, status = 'lodged',
      lodged_on = coalesce(lodged_on, (now() at time zone 'Australia/Sydney')::date)
      where id = p_job;
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'stp', 'STP lodged');
  else
    raise exception 'Unknown payroll step';
  end if;
end $$;
revoke all on function public.payroll_step(uuid, text) from public, anon;
grant execute on function public.payroll_step(uuid, text) to authenticated;

-- ============================================================
-- Default team member for each client's automatic jobs (payroll, BAS).
-- Empty = the client's manager, as before.
-- ============================================================
alter table public.clients add column if not exists payroll_assignee uuid references public.profiles (id) on delete set null;
alter table public.clients add column if not exists bas_assignee uuid references public.profiles (id) on delete set null;

create or replace function public.generate_payroll_jobs(lead_days integer default 7) returns integer
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  n integer;
begin
  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'payroll',
         case when c.payroll_freq = 'monthly' then to_char(x.d, 'Mon YYYY') else 'Pay ' || to_char(x.d, 'FMDD Mon YYYY') end,
         x.d, coalesce(c.payroll_assignee, c.manager_id)
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

create or replace function public.generate_bas_jobs() returns integer
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  q_end date := (date_trunc('quarter', today) - interval '1 day')::date;
  m_end date := (date_trunc('month', today) - interval '1 day')::date;
  m int := extract(month from q_end)::int;
  fy int := case when m >= 7 then extract(year from q_end)::int + 1 else extract(year from q_end)::int end;
  q int := case when m between 7 and 9 then 1 when m between 10 and 12 then 2 when m between 1 and 3 then 3 else 4 end;
  q_due date := case q when 1 then make_date(fy - 1, 11, 25) when 2 then make_date(fy, 2, 28) when 3 then make_date(fy, 5, 26) else make_date(fy, 8, 25) end;
  n1 int; n2 int;
begin
  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', 'Q' || q || ' FY' || right(fy::text, 2), q_due, coalesce(c.bas_assignee, c.manager_id)
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'quarterly'
    and today - q_end <= 31
  on conflict (client_id, service, period) do nothing;
  get diagnostics n1 = row_count;

  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', to_char(m_end, 'Mon YYYY'), (m_end + interval '21 days')::date, coalesce(c.bas_assignee, c.manager_id)
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'monthly'
  on conflict (client_id, service, period) do nothing;
  get diagnostics n2 = row_count;
  return n1 + n2;
end $$;
revoke all on function public.generate_bas_jobs() from public, anon;

-- ============================================================
-- Staff see only their own jobs (assigned, reviewing, sent for a query, or logged time on)
-- plus unassigned jobs. Team leaders and master admins see every job.
-- A staff member may take an unassigned job for themselves.
-- ============================================================
create or replace function public.can_see_job(j public.jobs) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active_member() and (
    public.my_role() is distinct from 'staff'
    or j.assignee_id is null
    or j.assignee_id = auth.uid()
    or j.reviewer_id = auth.uid()
    or j.query_from = auth.uid()
    or exists (select 1 from public.timesheet_entries e where e.job_id = j.id and e.user_id = auth.uid())
  );
$$;
revoke all on function public.can_see_job(public.jobs) from public, anon;
grant execute on function public.can_see_job(public.jobs) to authenticated;

drop policy if exists "members read jobs" on public.jobs;
create policy "members read jobs" on public.jobs
  for select to authenticated using (public.can_see_job(jobs));

-- Job history follows the job.
drop policy if exists "members read job activity" on public.job_activity;
create policy "members read job activity" on public.job_activity
  for select to authenticated using (exists (select 1 from public.jobs j where j.id = job_id));

create or replace function public.guard_job_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.my_role() is distinct from 'staff'
     or current_setting('supertax.job_handover', true) = 'on' then return new; end if;
  new.query_from := old.query_from;
  if new.status = 'lodged' and old.lodged_on is null then
    new.lodged_on := (now() at time zone 'Australia/Sydney')::date;
  else
    new.lodged_on := old.lodged_on;
  end if;
  if new.reviewer_id is distinct from old.reviewer_id
     and not (old.reviewer_id is null and new.reviewer_id is not distinct from (select reports_to from public.profiles where id = auth.uid())) then
    raise exception 'Only your manager can change the reviewer of a job' using errcode = '42501';
  end if;
  -- Taking an unassigned job for yourself is allowed.
  if old.assignee_id is null and new.assignee_id = auth.uid() then
    if (new.client_id, new.service, new.period, new.due_date, new.priority)
       is distinct from (old.client_id, old.service, old.period, old.due_date, old.priority) then
      raise exception 'Only your manager can change the client, service, period, due date or priority of a job' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.client_id, new.service, new.period, new.due_date, new.priority, new.assignee_id)
     is distinct from (old.client_id, old.service, old.period, old.due_date, old.priority, old.assignee_id) then
    raise exception 'Only your manager can change the client, service, period, due date, priority or assignee of a job' using errcode = '42501';
  end if;
  return new;
end $$;

-- ============================================================
-- A job can't be submitted for review until someone has started it
-- (pressed Start, or logged time against it).
-- ============================================================
create or replace function public.job_was_started(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.job_timers t where t.job_id = p_job)
      or exists (select 1 from public.timesheet_entries e where e.job_id = p_job);
$$;
revoke all on function public.job_was_started(uuid) from public, anon, authenticated;

create or replace function public.guard_review_needs_start() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'review' and old.status is distinct from 'review'
     and current_setting('supertax.payroll_step', true) is distinct from 'on'
     and not public.job_was_started(new.id) then
    raise exception 'Start the job first: press Start on it in My jobs, then submit it for review' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_review_needs_start() from public, anon, authenticated;
drop trigger if exists jobs_review_needs_start on public.jobs;
create trigger jobs_review_needs_start before update on public.jobs
  for each row execute function public.guard_review_needs_start();

-- Which jobs have been started (ids only), so the portal can grey out Submit for review.
create or replace function public.started_jobs() returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct job_id from public.job_timers where job_id is not null and public.is_active_member()
  union
  select distinct job_id from public.timesheet_entries where job_id is not null and public.is_active_member();
$$;
revoke all on function public.started_jobs() from public, anon;
grant execute on function public.started_jobs() to authenticated;

-- ============================================================
-- Review as a task: the reviewer can start the timer on a job waiting for their review,
-- and the preparer is told when it is approved or sent back.
-- ============================================================
create or replace function public.start_job(p_job uuid) returns public.job_timers
language plpgsql security definer set search_path = public as $$
declare j public.jobs; t public.job_timers;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from auth.uid()
     and not (j.status = 'review' and j.reviewer_id = auth.uid()) then
    raise exception 'You can only start jobs assigned to you or waiting for your review';
  end if;
  if j.status in ('lodged', 'done') then raise exception 'This job is already finished'; end if;
  select * into t from public.job_timers where user_id = auth.uid() and ended_at is null;
  if found then
    if t.job_id = p_job then return t; end if;
    perform public.end_job_timer(auth.uid());
  end if;
  insert into public.job_timers (user_id, job_id) values (auth.uid(), p_job) returning * into t;
  if j.status in ('not_started', 'waiting') then
    update public.jobs set status = 'in_progress' where id = p_job;
  end if;
  return t;
end $$;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('job_assigned', 'internal_query', 'query_answered', 'review', 'meeting', 'review_approved', 'review_returned'));

create or replace function public.notify_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); what text; k text;
begin
  select c.name || ' · ' || new.period into what from public.clients c where c.id = new.client_id;
  if new.assignee_id is not null and new.assignee_id is distinct from me
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    k := case
      when new.status = 'internal_query' and (tg_op = 'INSERT' or old.status is distinct from 'internal_query') then 'internal_query'
      when tg_op = 'UPDATE' and old.status = 'internal_query' and new.status is distinct from 'internal_query' then 'query_answered'
      else 'job_assigned' end;
    insert into public.notifications (user_id, actor_id, kind, job_id, service, body) values (new.assignee_id, me, k, new.id, new.service, coalesce(what, ''));
  end if;
  if tg_op = 'UPDATE' and new.status = 'review' and old.status is distinct from 'review'
     and new.reviewer_id is not null and new.reviewer_id is distinct from me and new.reviewer_id is distinct from new.assignee_id then
    insert into public.notifications (user_id, actor_id, kind, job_id, service, body) values (new.reviewer_id, me, 'review', new.id, new.service, coalesce(what, ''));
  end if;
  -- Review finished: tell the preparer.
  if tg_op = 'UPDATE' and old.status = 'review' and new.status is distinct from 'review'
     and new.assignee_id is not null and new.assignee_id is distinct from me
     and new.assignee_id is not distinct from old.assignee_id
     and new.status in ('to_lodge', 'sent_for_sign', 'lodged', 'done', 'in_progress', 'not_started', 'waiting') then
    insert into public.notifications (user_id, actor_id, kind, job_id, service, body)
    values (new.assignee_id, me, case when new.status in ('in_progress', 'not_started', 'waiting') then 'review_returned' else 'review_approved' end, new.id, new.service, coalesce(what, ''));
  end if;
  return new;
end $$;
revoke all on function public.notify_job() from public, anon, authenticated;

-- ============================================================
-- Staff can't change a job's status until the job has been started.
-- (Team leaders and master admins can, e.g. for admin work.)
-- ============================================================
create or replace function public.guard_status_needs_start() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and auth.uid() is not null and public.my_role() = 'staff'
     and current_setting('supertax.job_handover', true) is distinct from 'on'
     and current_setting('supertax.payroll_step', true) is distinct from 'on'
     and not public.job_was_started(new.id) then
    raise exception 'Start the job first: press Start on it in My jobs, then you can change its status' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_status_needs_start() from public, anon, authenticated;
drop trigger if exists jobs_status_needs_start on public.jobs;
create trigger jobs_status_needs_start before update on public.jobs
  for each row execute function public.guard_status_needs_start();

-- Staff don't see unassigned jobs that are finished (Completed, Sent for sign, Lodged).
create or replace function public.can_see_job(j public.jobs) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active_member() and (
    public.my_role() is distinct from 'staff'
    or (j.assignee_id is null and j.status not in ('done', 'sent_for_sign', 'lodged'))
    or j.assignee_id = auth.uid()
    or j.reviewer_id = auth.uid()
    or j.query_from = auth.uid()
    or exists (select 1 from public.timesheet_entries e where e.job_id = j.id and e.user_id = auth.uid())
  );
$$;

-- ============================================================
-- Sent for sign: the approver owns the job while the client signs.
-- After 2 days still unsigned, they get a bell reminder to chase the client (then every 2 days).
-- ============================================================
alter table public.jobs add column if not exists sign_sent_at timestamptz;
alter table public.jobs add column if not exists sign_owner uuid references public.profiles (id) on delete set null;
alter table public.jobs add column if not exists sign_reminded_at timestamptz;

create or replace function public.stamp_sent_for_sign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'sent_for_sign' and (tg_op = 'INSERT' or old.status is distinct from 'sent_for_sign') then
    new.sign_sent_at := now();
    new.sign_owner := coalesce(auth.uid(), new.reviewer_id, new.assignee_id);
    new.sign_reminded_at := null;
  elsif new.status is distinct from 'sent_for_sign' then
    new.sign_sent_at := null; new.sign_owner := null; new.sign_reminded_at := null;
  end if;
  return new;
end $$;
revoke all on function public.stamp_sent_for_sign() from public, anon, authenticated;
drop trigger if exists jobs_sent_for_sign on public.jobs;
create trigger jobs_sent_for_sign before insert or update on public.jobs
  for each row execute function public.stamp_sent_for_sign();

-- Jobs already waiting for a signature start their 2-day clock now.
update public.jobs set sign_sent_at = coalesce(sign_sent_at, now()), sign_owner = coalesce(sign_owner, reviewer_id, assignee_id)
where status = 'sent_for_sign' and sign_sent_at is null;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('job_assigned', 'internal_query', 'query_answered', 'review', 'meeting', 'review_approved', 'review_returned', 'sign_reminder'));

create or replace function public.remind_unsigned() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with due as (
    update public.jobs j set sign_reminded_at = now()
    where j.status = 'sent_for_sign' and j.sign_owner is not null
      and j.sign_sent_at <= now() - interval '2 days'
      and (j.sign_reminded_at is null or j.sign_reminded_at <= now() - interval '2 days')
    returning j.id, j.sign_owner, j.service, j.client_id, j.period
  )
  insert into public.notifications (user_id, actor_id, kind, job_id, service, body)
  select d.sign_owner, null, 'sign_reminder', d.id, d.service, coalesce(c.name, '') || ' · ' || d.period
  from due d left join public.clients c on c.id = d.client_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.remind_unsigned() from public, anon;
grant execute on function public.remind_unsigned() to authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('supertax-sign-reminders', '0 * * * *', 'select public.remind_unsigned()');
  end if;
end $$;

-- ============================================================
-- Approve -> "Ready for signing" (status to_lodge), owned by the approver.
-- They send it to the client -> "Sent for sign"; the 2-day reminder clock starts then.
-- ============================================================
create or replace function public.stamp_sent_for_sign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('to_lodge', 'sent_for_sign') then
    if tg_op = 'INSERT' or old.status not in ('to_lodge', 'sent_for_sign') or new.sign_owner is null then
      new.sign_owner := coalesce(auth.uid(), new.reviewer_id, new.assignee_id);
    end if;
    if new.status = 'sent_for_sign' and (tg_op = 'INSERT' or old.status is distinct from 'sent_for_sign') then
      new.sign_sent_at := now();
      new.sign_reminded_at := null;
    elsif new.status = 'to_lodge' then
      new.sign_sent_at := null; new.sign_reminded_at := null;
    end if;
  else
    new.sign_sent_at := null; new.sign_owner := null; new.sign_reminded_at := null;
  end if;
  return new;
end $$;
update public.jobs set sign_owner = coalesce(reviewer_id, assignee_id) where status = 'to_lodge' and sign_owner is null;

-- ============================================================
-- Once staff submit a job for review, they can't change its status any more
-- (Ready for review, Ready for signing, Sent for sign, Lodged, Completed),
-- unless the reviewer sends it back. Staff can't jump a job to those stages either.
-- The job's own reviewer / signer is not blocked.
-- ============================================================
create or replace function public.guard_staff_submitted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and auth.uid() is not null and public.my_role() = 'staff'
     and current_setting('supertax.job_handover', true) is distinct from 'on'
     and current_setting('supertax.payroll_step', true) is distinct from 'on'
     and auth.uid() is distinct from old.reviewer_id
     and auth.uid() is distinct from old.sign_owner then
    if old.status in ('review', 'to_lodge', 'sent_for_sign', 'lodged', 'done') then
      raise exception 'This job has been submitted for review. Only the reviewer can change its status now, unless they send it back to you' using errcode = '42501';
    end if;
    if new.status in ('to_lodge', 'sent_for_sign', 'lodged', 'done') then
      raise exception 'Submit the job for review. The reviewer moves it on from there' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_staff_submitted() from public, anon, authenticated;
drop trigger if exists jobs_staff_submitted on public.jobs;
create trigger jobs_staff_submitted before update on public.jobs
  for each row execute function public.guard_staff_submitted();

-- ============================================================
-- New status "Query with client": a question has gone to the client.
-- The job leaves My jobs; if there's no answer after 2 days, the person who owns it
-- gets a bell reminder to follow up (then every 2 days). Same pattern as Sent for sign.
-- ============================================================
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('not_started', 'waiting', 'internal_query', 'client_query', 'in_progress', 'review', 'to_lodge', 'sent_for_sign', 'lodged', 'done'));

create or replace function public.stamp_sent_for_sign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'client_query' then
    if tg_op = 'INSERT' or old.status is distinct from 'client_query' then
      new.sign_owner := coalesce(new.assignee_id, auth.uid());
      new.sign_sent_at := now();
      new.sign_reminded_at := null;
    end if;
  elsif new.status in ('to_lodge', 'sent_for_sign') then
    if tg_op = 'INSERT' or old.status not in ('to_lodge', 'sent_for_sign') or new.sign_owner is null then
      new.sign_owner := coalesce(auth.uid(), new.reviewer_id, new.assignee_id);
    end if;
    if new.status = 'sent_for_sign' and (tg_op = 'INSERT' or old.status is distinct from 'sent_for_sign') then
      new.sign_sent_at := now();
      new.sign_reminded_at := null;
    elsif new.status = 'to_lodge' then
      new.sign_sent_at := null; new.sign_reminded_at := null;
    end if;
  else
    new.sign_sent_at := null; new.sign_owner := null; new.sign_reminded_at := null;
  end if;
  return new;
end $$;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('job_assigned', 'internal_query', 'query_answered', 'review', 'meeting', 'review_approved', 'review_returned', 'sign_reminder', 'client_query_reminder'));

create or replace function public.remind_unsigned() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with due as (
    update public.jobs j set sign_reminded_at = now()
    where j.status in ('sent_for_sign', 'client_query') and j.sign_owner is not null
      and j.sign_sent_at <= now() - interval '2 days'
      and (j.sign_reminded_at is null or j.sign_reminded_at <= now() - interval '2 days')
    returning j.id, j.status, j.sign_owner, j.service, j.client_id, j.period
  )
  insert into public.notifications (user_id, actor_id, kind, job_id, service, body)
  select d.sign_owner, null, case when d.status = 'client_query' then 'client_query_reminder' else 'sign_reminder' end,
         d.id, d.service, coalesce(c.name, '') || ' · ' || d.period
  from due d left join public.clients c on c.id = d.client_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Pressing Start on a job that was waiting on the client puts it back in progress.
create or replace function public.start_job(p_job uuid) returns public.job_timers
language plpgsql security definer set search_path = public as $$
declare j public.jobs; t public.job_timers;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from auth.uid()
     and not (j.status = 'review' and j.reviewer_id = auth.uid()) then
    raise exception 'You can only start jobs assigned to you or waiting for your review';
  end if;
  if j.status in ('lodged', 'done') then raise exception 'This job is already finished'; end if;
  select * into t from public.job_timers where user_id = auth.uid() and ended_at is null;
  if found then
    if t.job_id = p_job then return t; end if;
    perform public.end_job_timer(auth.uid());
  end if;
  insert into public.job_timers (user_id, job_id) values (auth.uid(), p_job) returning * into t;
  if j.status in ('not_started', 'waiting', 'client_query') then
    update public.jobs set status = 'in_progress' where id = p_job;
  end if;
  return t;
end $$;

-- ============================================================
-- Each client belongs to a practice: Supertax, Titantax, Workpaper or Monarch Accounting.
-- Existing clients become Supertax.
-- ============================================================
alter table public.clients add column if not exists practice text not null default 'Supertax';
alter table public.clients drop constraint if exists clients_practice_check;
alter table public.clients add constraint clients_practice_check
  check (practice in ('Supertax', 'Titantax', 'Workpaper', 'Monarch Accounting'));

-- ============================================================
-- Client address, and the import can now bring in Practice and Address.
-- ============================================================
alter table public.clients add column if not exists address text not null default '';

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
  insert into public.clients (practice, name, entity, abn, contact, email, phone, address, manager_id, services, bas_freq, notes)
  select coalesce(nullif(trim(r.practice), ''), 'Supertax'), trim(r.name), coalesce(nullif(trim(r.entity), ''), 'Company'),
         coalesce(r.abn, ''), coalesce(r.contact, ''), coalesce(r.email, ''), coalesce(r.phone, ''), coalesce(r.address, ''),
         r.manager_id, coalesce(r.services, '{}'), coalesce(nullif(r.bas_freq, ''), 'quarterly'), coalesce(r.notes, '')
  from jsonb_to_recordset(rows) as r(practice text, name text, entity text, abn text, contact text, email text, phone text,
                                     address text, manager_id uuid, services text[], bas_freq text, notes text);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.import_clients(jsonb) from public, anon;
grant execute on function public.import_clients(jsonb) to authenticated;

-- ============================================================
-- Related clients: link a company to its directors, husband and wife, a trust to its trustee, etc.
-- Linked clients form a group, so the whole group's pending work can be seen and finished together.
-- A link reads "<client_id> is the <relation> of <related_id>", e.g. "Jane is the director of ABC Pty Ltd".
-- ============================================================
create table if not exists public.client_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  related_id uuid not null references public.clients (id) on delete cascade,
  relation text not null default 'other'
    check (relation in ('director', 'shareholder', 'spouse', 'partner', 'trustee', 'beneficiary', 'member', 'parent', 'other')),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (client_id <> related_id)
);
-- One link per pair of clients (either way round).
create unique index if not exists client_links_pair_idx on public.client_links (least(client_id, related_id), greatest(client_id, related_id));
create index if not exists client_links_related_idx on public.client_links (related_id);
alter table public.client_links enable row level security;
drop policy if exists "members read client links" on public.client_links;
create policy "members read client links" on public.client_links
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add client links" on public.client_links;
create policy "members add client links" on public.client_links
  for insert to authenticated with check (public.is_active_member());
drop policy if exists "members remove client links" on public.client_links;
create policy "members remove client links" on public.client_links
  for delete to authenticated using (public.is_active_member());
revoke all on public.client_links from anon;
grant select, insert, delete on public.client_links to authenticated;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.client_links; exception when duplicate_object then null; end;
  end if;
end $$;

-- ============================================================
-- Annual BAS / GST cycle: clients can be set to Annually. An "Annual GST FY26" job is created
-- automatically in July after the financial year ends, due 15 May (with the tax return).
-- ============================================================
alter table public.clients drop constraint if exists clients_bas_freq_check;
alter table public.clients add constraint clients_bas_freq_check check (bas_freq in ('quarterly', 'monthly', 'annual'));

create or replace function public.generate_bas_jobs() returns integer
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  q_end date := (date_trunc('quarter', today) - interval '1 day')::date;
  m_end date := (date_trunc('month', today) - interval '1 day')::date;
  m int := extract(month from q_end)::int;
  fy int := case when m >= 7 then extract(year from q_end)::int + 1 else extract(year from q_end)::int end;
  q int := case when m between 7 and 9 then 1 when m between 10 and 12 then 2 when m between 1 and 3 then 3 else 4 end;
  q_due date := case q when 1 then make_date(fy - 1, 11, 25) when 2 then make_date(fy, 2, 28) when 3 then make_date(fy, 5, 26) else make_date(fy, 8, 25) end;
  -- The financial year that ended most recently (30 June).
  y_end date := make_date(case when extract(month from today) >= 7 then extract(year from today)::int else extract(year from today)::int - 1 end, 6, 30);
  n1 int; n2 int; n3 int;
begin
  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', 'Q' || q || ' FY' || right(fy::text, 2), q_due, coalesce(c.bas_assignee, c.manager_id)
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'quarterly'
    and today - q_end <= 31
  on conflict (client_id, service, period) do nothing;
  get diagnostics n1 = row_count;

  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', to_char(m_end, 'Mon YYYY'), (m_end + interval '21 days')::date, coalesce(c.bas_assignee, c.manager_id)
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'monthly'
  on conflict (client_id, service, period) do nothing;
  get diagnostics n2 = row_count;

  insert into public.jobs (client_id, service, period, due_date, assignee_id)
  select c.id, 'bas', 'Annual GST FY' || to_char(y_end, 'YY'), make_date(extract(year from y_end)::int + 1, 5, 15), coalesce(c.bas_assignee, c.manager_id)
  from public.clients c
  where 'bas' = any (c.services) and c.bas_freq = 'annual'
    and today - y_end <= 31
  on conflict (client_id, service, period) do nothing;
  get diagnostics n3 = row_count;
  return n1 + n2 + n3;
end $$;
revoke all on function public.generate_bas_jobs() from public, anon;

-- Clients whose only BAS jobs are Annual GST are set to Annually.
update public.clients c set bas_freq = 'annual'
where c.bas_freq <> 'annual'
  and exists (select 1 from public.jobs j where j.client_id = c.id and j.service = 'bas' and j.period ilike 'Annual GST%')
  and not exists (select 1 from public.jobs j where j.client_id = c.id and j.service = 'bas' and j.period not ilike 'Annual GST%');

-- ============================================================
-- Timer on "Ready for signing" and "Sent for sign" jobs: the person preparing the signing
-- documents (or chasing the signature) can Start/Stop, and the time goes to their timesheet.
-- ============================================================
create or replace function public.start_job(p_job uuid) returns public.job_timers
language plpgsql security definer set search_path = public as $$
declare j public.jobs; t public.job_timers;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from auth.uid()
     and not (j.status = 'review' and j.reviewer_id = auth.uid())
     and not (j.status = 'to_lodge' and coalesce(j.sign_owner, j.reviewer_id, j.assignee_id) = auth.uid())
     and not (j.status = 'sent_for_sign' and coalesce(j.sign_owner, j.reviewer_id, j.assignee_id) = auth.uid()) then
    raise exception 'You can only start jobs assigned to you, waiting for your review or ready for your signing';
  end if;
  if j.status in ('lodged', 'done') then raise exception 'This job is already finished'; end if;
  select * into t from public.job_timers where user_id = auth.uid() and ended_at is null;
  if found then
    if t.job_id = p_job then return t; end if;
    perform public.end_job_timer(auth.uid());
  end if;
  insert into public.job_timers (user_id, job_id) values (auth.uid(), p_job) returning * into t;
  if j.status in ('not_started', 'waiting', 'client_query') then
    update public.jobs set status = 'in_progress' where id = p_job;
  end if;
  return t;
end $$;
revoke all on function public.start_job(uuid) from public, anon;
grant execute on function public.start_job(uuid) to authenticated;

create or replace function public.end_job_timer(p_uid uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  t public.job_timers;
  j public.jobs;
  tz constant text := 'Australia/Sydney';
  hrs numeric;
  e uuid;
begin
  select * into t from public.job_timers where user_id = p_uid and ended_at is null for update;
  if not found then return null; end if;
  select * into j from public.jobs where id = t.job_id;
  hrs := least(24, greatest(0.01, round((extract(epoch from now() - t.started_at) / 3600)::numeric, 2)));
  perform set_config('supertax.timer_stop', 'on', true);
  insert into public.timesheet_entries (user_id, work_date, client_id, job_id, hours, description)
  values (p_uid, (t.started_at at time zone tz)::date, j.client_id, t.job_id, hrs,
          case when j.status = 'internal_query' and j.assignee_id = p_uid then 'Internal review, timer '
               when j.status = 'to_lodge' then 'Preparing for signing, timer '
               when j.status = 'sent_for_sign' then 'Signing follow-up, timer '
               else 'Timer ' end
          || lower(to_char(t.started_at at time zone tz, 'FMHH12:MIAM')) || ' to ' || lower(to_char(now() at time zone tz, 'FMHH12:MIAM')))
  returning id into e;
  perform set_config('supertax.timer_stop', 'off', true);
  update public.job_timers set ended_at = now(), entry_id = e where id = t.id;
  return hrs;
end $$;
revoke all on function public.end_job_timer(uuid) from public, anon, authenticated;

-- ============================================================
-- Hand a "Ready for signing" or "Sent for sign" job to a team member.
-- They become the signing owner: it shows in their My jobs, they get the 2-day reminders,
-- can run the timer, and can mark it sent / signed.
-- ============================================================
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('job_assigned', 'internal_query', 'query_answered', 'review', 'meeting', 'review_approved', 'review_returned', 'sign_reminder', 'client_query_reminder', 'sign_handover'));

create or replace function public.can_see_job(j public.jobs) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active_member() and (
    public.my_role() is distinct from 'staff'
    or (j.assignee_id is null and j.status not in ('done', 'sent_for_sign', 'lodged'))
    or j.assignee_id = auth.uid()
    or j.reviewer_id = auth.uid()
    or j.query_from = auth.uid()
    or j.sign_owner = auth.uid()
    or exists (select 1 from public.timesheet_entries e where e.job_id = j.id and e.user_id = auth.uid())
  );
$$;

create or replace function public.hand_signing(p_job uuid, p_to uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.status not in ('to_lodge', 'sent_for_sign') then
    raise exception 'Only jobs that are Ready for signing or Sent for sign can be handed over';
  end if;
  if coalesce(public.my_role()::text, '') not in ('master', 'manager')
     and coalesce(j.sign_owner, j.reviewer_id, j.assignee_id) is distinct from me then
    raise exception 'Only the person handling the signing, a team leader or a master admin can hand it over' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'Pick an active team member';
  end if;
  select full_name into who from public.profiles where id = me;
  update public.jobs set sign_owner = p_to,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both e'\n' from coalesce(notes, '') || e'\n' || 'Signing handed over by ' || coalesce(who, 'a team member') || ': ' || trim(p_note)) end
  where id = p_job;
  if p_to is distinct from me then
    insert into public.notifications (user_id, actor_id, kind, job_id, service, body)
    select p_to, me, 'sign_handover', j.id, j.service, coalesce(c.name, '') || ' · ' || j.period
    from public.clients c where c.id = j.client_id;
  end if;
end $$;
revoke all on function public.hand_signing(uuid, uuid, text) from public, anon;
grant execute on function public.hand_signing(uuid, uuid, text) to authenticated;

-- ============================================================
-- Prospects: possible new clients still in discussion. Kept apart from the client list
-- and job counts. "Convert to client" creates the client and marks the prospect Won.
-- ============================================================
create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  practice text not null default 'Supertax' check (practice in ('Supertax', 'Titantax', 'Workpaper', 'Monarch Accounting')),
  name text not null check (length(trim(name)) > 0 and length(name) <= 200),
  entity text not null default 'Individual',
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  services text[] not null default '{}',
  fee numeric(12, 2) check (fee is null or fee >= 0),
  source text not null default '',
  stage text not null default 'new' check (stage in ('new', 'contacted', 'meeting', 'proposal', 'won', 'lost')),
  follow_up date,
  owner_id uuid references public.profiles (id) on delete set null,
  notes text not null default '' check (length(notes) <= 8000),
  lost_reason text not null default '',
  client_id uuid references public.clients (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prospects_stage_idx on public.prospects (stage, follow_up);
alter table public.prospects enable row level security;
drop policy if exists "members read prospects" on public.prospects;
create policy "members read prospects" on public.prospects
  for select to authenticated using (public.is_active_member());
drop policy if exists "members add prospects" on public.prospects;
create policy "members add prospects" on public.prospects
  for insert to authenticated with check (public.is_active_member());
drop policy if exists "members edit prospects" on public.prospects;
create policy "members edit prospects" on public.prospects
  for update to authenticated using (public.is_active_member()) with check (public.is_active_member());
drop policy if exists "delete prospects with delete access" on public.prospects;
create policy "delete prospects with delete access" on public.prospects
  for delete to authenticated using (public.can_delete_data());
revoke all on public.prospects from anon;
grant select, insert, update, delete on public.prospects to authenticated;

create or replace function public.stamp_prospect() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.created_at := old.created_at; new.created_by := old.created_by; end if;
  return new;
end $$;
drop trigger if exists prospects_stamp on public.prospects;
create trigger prospects_stamp before insert or update on public.prospects
  for each row execute function public.stamp_prospect();

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.prospects; exception when duplicate_object then null; end;
  end if;
end $$;

-- ============================================================
-- Submit for review to a chosen senior or manager, with an optional note for them.
-- ============================================================
create or replace function public.submit_for_review(p_job uuid, p_to uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from me and public.my_role() not in ('master', 'manager') then
    raise exception 'Only the person working on this job can submit it for review' using errcode = '42501';
  end if;
  if j.status in ('review', 'to_lodge', 'sent_for_sign', 'lodged', 'done') then
    raise exception 'This job has already been submitted';
  end if;
  if p_to is null or p_to = me or not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'Choose who should review this job';
  end if;
  -- Log any time running on this job first.
  if exists (select 1 from public.job_timers where user_id = me and job_id = p_job and ended_at is null) then
    perform public.end_job_timer(me);
  end if;
  select full_name into who from public.profiles where id = me;
  perform set_config('supertax.job_handover', 'on', true);
  update public.jobs set
    status = 'review',
    reviewer_id = p_to,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both E'\n' from coalesce(notes, '') || E'\n' || 'Submitted for review by ' || coalesce(who, 'a team member') || ' (' || to_char(now() at time zone 'Australia/Sydney', 'FMDD Mon') || '): ' || trim(p_note)) end
  where id = p_job;
  perform set_config('supertax.job_handover', 'off', true);
  if coalesce(trim(p_note), '') <> '' then
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'comment', 'For review: ' || trim(p_note));
  end if;
end $$;
revoke all on function public.submit_for_review(uuid, uuid, text) from public, anon;
grant execute on function public.submit_for_review(uuid, uuid, text) to authenticated;

-- ============================================================
-- Job files: attach query sheets, client documents and workpapers to a job.
-- Files live in a private storage bucket "job-files", in a folder per job (<job id>/...).
-- Anyone who can see the job can see and add its files; the uploader or anyone with
-- delete access can remove one.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('job-files', 'job-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

create table if not exists public.job_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  path text not null unique,
  name text not null check (length(name) between 1 and 255),
  size bigint not null default 0,
  mime text not null default '',
  kind text not null default 'document' check (kind in ('query_sheet', 'document', 'workpaper', 'other')),
  uploaded_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists job_files_job_idx on public.job_files (job_id, created_at desc);
alter table public.job_files enable row level security;
drop policy if exists "see files of jobs you can see" on public.job_files;
create policy "see files of jobs you can see" on public.job_files for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_id and public.can_see_job(j)));
drop policy if exists "add files to jobs you can see" on public.job_files;
create policy "add files to jobs you can see" on public.job_files for insert to authenticated
  with check (uploaded_by = auth.uid() and path like job_id::text || '/%'
              and exists (select 1 from public.jobs j where j.id = job_id and public.can_see_job(j)));
drop policy if exists "remove own files or with delete access" on public.job_files;
create policy "remove own files or with delete access" on public.job_files for delete to authenticated
  using (public.is_active_member() and (uploaded_by = auth.uid() or public.can_delete_data()));
revoke all on public.job_files from anon;
grant select, insert, delete on public.job_files to authenticated;

drop policy if exists "job files: read" on storage.objects;
create policy "job files: read" on storage.objects for select to authenticated
  using (bucket_id = 'job-files' and exists (
    select 1 from public.jobs j where j.id::text = (storage.foldername(name))[1] and public.can_see_job(j)));
drop policy if exists "job files: upload" on storage.objects;
create policy "job files: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files' and exists (
    select 1 from public.jobs j where j.id::text = (storage.foldername(name))[1] and public.can_see_job(j)));
drop policy if exists "job files: delete" on storage.objects;
create policy "job files: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'job-files' and public.is_active_member() and (owner_id = auth.uid()::text or public.can_delete_data()));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.job_files; exception when duplicate_object then null; end;
  end if;
end $$;

-- ============================================================
-- Emails sent to clients from a job (through the practice's Microsoft 365 mailbox).
-- A log for the team; the email itself is also in the mailbox's Sent Items.
-- ============================================================
create table if not exists public.job_emails (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  sent_by uuid references public.profiles (id) on delete set null,
  to_addr text[] not null default '{}',
  cc_addr text[] not null default '{}',
  subject text not null default '',
  body text not null default '',
  files text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists job_emails_job_idx on public.job_emails (job_id, created_at desc);
alter table public.job_emails enable row level security;
drop policy if exists "see emails of jobs you can see" on public.job_emails;
create policy "see emails of jobs you can see" on public.job_emails for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_id and public.can_see_job(j)));
-- Rows are written by the server after the email is sent, never directly by the browser.
revoke all on public.job_emails from anon, authenticated;
grant select on public.job_emails to authenticated;


-- ============================================================
-- A team member who has been set as a job's reviewer (by a manager or master admin) acts as the
-- reviewer: they can move the status on, and can submit their own job to themselves for review.
-- Staff can't make themselves the reviewer.
-- ============================================================
drop function if exists public.review_myself(uuid);

create or replace function public.submit_for_review(p_job uuid, p_to uuid, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare j public.jobs; me uuid := auth.uid(); who text;
begin
  if not public.is_active_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job no longer exists'; end if;
  if j.assignee_id is distinct from me and public.my_role() not in ('master', 'manager') then
    raise exception 'Only the person working on this job can submit it for review' using errcode = '42501';
  end if;
  if j.status in ('review', 'to_lodge', 'sent_for_sign', 'lodged', 'done') then
    raise exception 'This job has already been submitted';
  end if;
  if p_to is null or not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'Choose who should review this job';
  end if;
  -- Submitting to yourself only if you've been made this job's reviewer.
  if p_to = me and j.reviewer_id is distinct from me then
    raise exception 'Choose another team member to review this job';
  end if;
  if exists (select 1 from public.job_timers where user_id = me and job_id = p_job and ended_at is null) then
    perform public.end_job_timer(me);
  end if;
  select full_name into who from public.profiles where id = me;
  perform set_config('supertax.job_handover', 'on', true);
  update public.jobs set
    status = 'review',
    reviewer_id = p_to,
    notes = case when coalesce(trim(p_note), '') = '' then notes
                 else trim(both E'\n' from coalesce(notes, '') || E'\n' || 'Submitted for review by ' || coalesce(who, 'a team member') || ' (' || to_char(now() at time zone 'Australia/Sydney', 'FMDD Mon') || '): ' || trim(p_note)) end
  where id = p_job;
  perform set_config('supertax.job_handover', 'off', true);
  if coalesce(trim(p_note), '') <> '' then
    insert into public.job_activity (job_id, actor_id, kind, body) values (p_job, me, 'comment', 'For review: ' || trim(p_note));
  end if;
end $$;
revoke all on function public.submit_for_review(uuid, uuid, text) from public, anon;
grant execute on function public.submit_for_review(uuid, uuid, text) to authenticated;
