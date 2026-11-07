export type Role = "master" | "manager" | "staff";

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  title: string;
  role: Role;
  active: boolean;
  must_change_password: boolean;
  reports_to?: string | null;
  can_delete?: boolean;
  created_at: string;
}

/** Names-only view of everyone, for showing who a job is assigned to. */
export interface Person {
  id: string;
  full_name: string;
  title: string;
  active: boolean;
}

export interface Client {
  id: string;
  name: string;
  entity: string;
  abn: string;
  contact: string;
  email: string;
  phone: string;
  manager_id: string | null;
  services: string[];
  bas_freq: "quarterly" | "monthly";
  payroll_freq?: "" | "weekly" | "fortnightly" | "monthly";
  payroll_anchor?: string | null;
  notes: string;
  updated_at: string;
  updated_by: string | null;
}

export interface Job {
  id: string;
  client_id: string;
  service: string;
  period: string;
  due_date: string | null;
  assignee_id: string | null;
  reviewer_id: string | null;
  status: StatusId;
  priority: "normal" | "high";
  notes: string;
  lodged_on: string | null;
  query_from?: string | null;
  updated_at: string;
  updated_by: string | null;
}

export type StatusId = "not_started" | "waiting" | "internal_query" | "in_progress" | "review" | "to_lodge" | "sent_for_sign" | "lodged";

export interface Attendance {
  id: string;
  user_id: string;
  work_date: string;
  clock_in: string;
  clock_out: string | null;
}

export interface TimeEntry {
  id: string;
  user_id: string;
  work_date: string;
  client_id: string | null;
  job_id: string | null;
  hours: number;
  description: string;
}

export interface JobTimer {
  id: string;
  user_id: string;
  job_id: string | null;
  started_at: string;
  ended_at: string | null;
}
