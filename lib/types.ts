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
  updated_at: string;
  updated_by: string | null;
}

export type StatusId = "not_started" | "waiting" | "in_progress" | "review" | "to_lodge" | "lodged" | "done";
