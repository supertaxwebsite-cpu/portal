import type { StatusId } from "./types";

export type ServiceKind = "bas" | "monthly" | "annual" | "fbt" | "custom";
export interface Service { id: string; label: string; kind: ServiceKind; rule?: "may15" | "aug28" }

export const SERVICES: Service[] = [
  { id: "bas", label: "BAS", kind: "bas" },
  { id: "ias", label: "IAS / PAYG instalment", kind: "bas" },
  { id: "payroll", label: "Payroll / STP", kind: "monthly" },
  { id: "bookkeeping", label: "Bookkeeping", kind: "monthly" },
  { id: "itr", label: "Individual tax return", kind: "annual", rule: "may15" },
  { id: "ctr", label: "Company tax return", kind: "annual", rule: "may15" },
  { id: "trust", label: "Trust tax return", kind: "annual", rule: "may15" },
  { id: "partnership", label: "Partnership return", kind: "annual", rule: "may15" },
  { id: "smsf", label: "SMSF return & audit", kind: "annual", rule: "may15" },
  { id: "fin", label: "Financial statements", kind: "annual" },
  { id: "fbt", label: "FBT return", kind: "fbt" },
  { id: "tpar", label: "TPAR", kind: "annual", rule: "aug28" },
  { id: "asic", label: "ASIC annual review", kind: "custom" },
  { id: "other", label: "Other", kind: "custom" },
];
export const SVC: Record<string, Service> = Object.fromEntries(SERVICES.map((s) => [s.id, s]));
export const svcLabel = (id: string) => SVC[id]?.label ?? id;

export interface Status { id: StatusId; label: string; cls: string; open: boolean }
export const STATUSES: Status[] = [
  { id: "not_started", label: "Not started", cls: "none", open: true },
  { id: "waiting", label: "Waiting on client", cls: "warn", open: true },
  { id: "internal_query", label: "Internal query", cls: "danger", open: true },
  { id: "in_progress", label: "In progress", cls: "info", open: true },
  { id: "review", label: "Ready for review", cls: "accent", open: true },
  { id: "to_lodge", label: "Ready for signing", cls: "accent", open: true },
  { id: "sent_for_sign", label: "Sent for sign", cls: "warn", open: true },
  { id: "lodged", label: "Lodged", cls: "ok", open: false },
  { id: "done", label: "Completed", cls: "ok", open: false }, // change requests and admin work, never lodged
];
export const ST: Record<string, Status> = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
export const isOpen = (status: string) => ST[status]?.open !== false;

export const ENTITIES = ["Individual", "Sole trader", "Company", "Trust", "Partnership", "SMSF", "Other"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const todayISO = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const dnum = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
export const daysFrom = (s: string) => dnum(s) - dnum(todayISO());
export const fmtDate = (s: string | null | undefined) => {
  if (!s) return "—";
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
export const currentFY = () => { const d = new Date(); return d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear(); };

export interface PeriodInput { freq: "quarterly" | "monthly"; fy: number; q: number; month: string; text: string }

/** Suggested due dates from the ATO tax agent lodgment program (electronic lodgment).
 *  They are a starting point; confirm each client's actual due date. */
export function suggestDue(service: string, p: PeriodInput): string {
  const s = SVC[service];
  if (!s) return "";
  const nextMonth = (month: string, day: number) => {
    if (!month) return "";
    let [y, m] = month.split("-").map(Number);
    m++; if (m > 12) { m = 1; y++; }
    return iso(y, m, day);
  };
  if (s.kind === "bas" && p.freq === "quarterly") {
    const fy = p.fy;
    return ({ 1: iso(fy - 1, 11, 25), 2: iso(fy, 2, 28), 3: iso(fy, 5, 26), 4: iso(fy, 8, 25) } as Record<number, string>)[p.q] ?? "";
  }
  if (s.kind === "bas" && p.freq === "monthly") return nextMonth(p.month, 21);
  if (s.kind === "monthly") return nextMonth(p.month, 7);
  if (s.kind === "annual") {
    if (s.rule === "may15") return iso(p.fy + 1, 5, 15);
    if (s.rule === "aug28") return iso(p.fy, 8, 28);
    return "";
  }
  if (s.kind === "fbt") return iso(p.fy, 6, 25);
  return "";
}

export function periodLabel(service: string, p: PeriodInput): string {
  const s = SVC[service];
  if (!s) return "";
  if (s.kind === "bas" && p.freq === "quarterly") return `Q${p.q} FY${String(p.fy).slice(2)}`;
  if ((s.kind === "bas" && p.freq === "monthly") || s.kind === "monthly") {
    if (!p.month) return "";
    const [y, m] = p.month.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  if (s.kind === "annual") return `FY${p.fy}`;
  if (s.kind === "fbt") return `FBT ${p.fy}`;
  return p.text.trim();
}

export const roleLabel = (r: string) => (r === "master" ? "Master admin" : r === "manager" ? "Team leader" : "Staff");

/** Work the portal will create automatically later (shown as "Projected work"). */
export interface Projected { key: string; label: string; detail: string; appears: string; clients: string[] }
export function projectedWork(clients: { id: string; name: string; services: string[]; bas_freq: string; payroll_freq?: string; payroll_anchor?: string | null }[], days = 14): Projected[] {
  const today = todayISO();
  const [y, m] = today.split("-").map(Number);
  const out: Projected[] = [];
  // Quarterly BAS for the quarter we're in: appears the day after the quarter ends.
  const fy = m >= 7 ? y + 1 : y;
  const q = m >= 7 && m <= 9 ? 1 : m >= 10 ? 2 : m <= 3 ? 3 : 4;
  const qEndMonth = [9, 12, 3, 6][q - 1];
  const qEndYear = q <= 2 ? fy - 1 : fy;
  const after = (yy: number, mm: number) => (mm === 12 ? iso(yy + 1, 1, 1) : iso(yy, mm + 1, 1));
  const qb = clients.filter((c) => c.services.includes("bas") && c.bas_freq === "quarterly");
  if (qb.length) out.push({ key: "bas-q", label: `BAS Q${q} FY${String(fy).slice(2)}`, detail: `${qb.length} quarterly BAS client${qb.length === 1 ? "" : "s"}`, appears: after(qEndYear, qEndMonth), clients: qb.map((c) => c.name) });
  const mb = clients.filter((c) => c.services.includes("bas") && c.bas_freq === "monthly");
  if (mb.length) out.push({ key: "bas-m", label: `BAS ${MONTHS[m - 1]} ${y}`, detail: `${mb.length} monthly BAS client${mb.length === 1 ? "" : "s"}`, appears: after(y, m), clients: mb.map((c) => c.name) });
  // Payroll pay days in the next couple of weeks (after today).
  const dnumL = (s: string) => { const [a, b, c] = s.split("-").map(Number); return Date.UTC(a, b - 1, c) / 864e5; };
  const fromNum = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
  const t0 = dnumL(today);
  const pay = new Map<string, string[]>();
  clients.filter((c) => c.services.includes("payroll") && c.payroll_freq && c.payroll_anchor).forEach((c) => {
    const a = dnumL(c.payroll_anchor!);
    for (let n = t0 + 1; n <= t0 + days; n++) {
      if (n < a) continue;
      const d = fromNum(n);
      let hit = false;
      if (c.payroll_freq === "weekly") hit = (n - a) % 7 === 0;
      else if (c.payroll_freq === "fortnightly") hit = (n - a) % 14 === 0;
      else if (c.payroll_freq === "monthly") {
        const [dy, dm, dd] = d.split("-").map(Number);
        const last = new Date(Date.UTC(dy, dm, 0)).getUTCDate();
        hit = dd === Math.min(Number(c.payroll_anchor!.slice(8, 10)), last);
      }
      if (hit) pay.set(d, [...(pay.get(d) ?? []), c.name]);
    }
  });
  [...pay.entries()].sort().forEach(([d, names]) => out.push({ key: `pay-${d}`, label: `Payroll · pay day ${fmtDate(d)}`, detail: `${names.length} client${names.length === 1 ? "" : "s"}`, appears: d, clients: names }));
  return out.sort((a, b) => a.appears.localeCompare(b.appears));
}

export interface Upcoming { key: string; service: string; period: string; appears: string; due: string }
/** Jobs that will be created automatically for one client (BAS after each period ends, payroll on each pay day).
 *  Leaves out any that already exist. */
export function clientUpcoming(c: { services: string[]; bas_freq: string; payroll_freq?: string; payroll_anchor?: string | null }, existing: { service: string; period: string }[], days = 120): Upcoming[] {
  const today = todayISO();
  const [y, m] = today.split("-").map(Number);
  const dn = (s: string) => { const [a, b, d] = s.split("-").map(Number); return Date.UTC(a, b - 1, d) / 864e5; };
  const fromNum = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
  const horizon = dn(today) + days;
  const has = new Set(existing.map((j) => `${j.service}|${j.period}`));
  const out: Upcoming[] = [];
  const add = (u: Upcoming) => { if (!has.has(`${u.service}|${u.period}`) && u.appears > today && dn(u.appears) <= horizon) out.push(u); };
  const after = (yy: number, mm: number) => (mm === 12 ? iso(yy + 1, 1, 1) : iso(yy, mm + 1, 1));
  if (c.services.includes("bas")) {
    if (c.bas_freq === "monthly") {
      for (let k = 0; k < 5; k++) {
        const mm = ((m - 1 + k) % 12) + 1, yy = y + Math.floor((m - 1 + k) / 12);
        const p: PeriodInput = { freq: "monthly", fy: 0, q: 0, month: `${yy}-${pad(mm)}`, text: "" };
        add({ key: `bas-${yy}-${mm}`, service: "bas", period: periodLabel("bas", p), appears: after(yy, mm), due: suggestDue("bas", p) });
      }
    } else {
      let fy = m >= 7 ? y + 1 : y, q = m >= 7 && m <= 9 ? 1 : m >= 10 ? 2 : m <= 3 ? 3 : 4;
      for (let k = 0; k < 3; k++) {
        const endMonth = [9, 12, 3, 6][q - 1], endYear = q <= 2 ? fy - 1 : fy;
        const p: PeriodInput = { freq: "quarterly", fy, q, month: "", text: "" };
        add({ key: `bas-q${q}-${fy}`, service: "bas", period: periodLabel("bas", p), appears: after(endYear, endMonth), due: suggestDue("bas", p) });
        q++; if (q > 4) { q = 1; fy++; }
      }
    }
  }
  if (c.services.includes("payroll") && c.payroll_freq && c.payroll_anchor) {
    const a = dn(c.payroll_anchor);
    for (let n = dn(today) + 1; n <= horizon && out.filter((u) => u.service === "payroll").length < 8; n++) {
      if (n < a) continue;
      const d = fromNum(n);
      let hit = false;
      if (c.payroll_freq === "weekly") hit = (n - a) % 7 === 0;
      else if (c.payroll_freq === "fortnightly") hit = (n - a) % 14 === 0;
      else if (c.payroll_freq === "monthly") {
        const [dy, dm, dd] = d.split("-").map(Number);
        hit = dd === Math.min(Number(c.payroll_anchor.slice(8, 10)), new Date(Date.UTC(dy, dm, 0)).getUTCDate());
      }
      if (hit) {
        const [dy, dm, dd] = d.split("-").map(Number);
        add({ key: `pay-${d}`, service: "payroll", period: c.payroll_freq === "monthly" ? `${MONTHS[dm - 1]} ${dy}` : `Pay ${dd} ${MONTHS[dm - 1]} ${dy}`, appears: d, due: d });
      }
    }
  }
  return out.sort((a, b) => a.appears.localeCompare(b.appears));
}

export interface PeriodOption { label: string; due: string }
export interface PeriodGroup { label: string; options: PeriodOption[] }
/** Period choices for the New job form, based on the service and the client's settings. */
export function periodOptions(service: string, client?: { bas_freq?: string; payroll_freq?: string; payroll_anchor?: string | null }): PeriodGroup[] {
  const s = SVC[service];
  if (!s || s.kind === "custom") return [];
  const today = todayISO();
  const [y, m] = today.split("-").map(Number);
  const months = (back: number, ahead: number) => {
    const out: PeriodOption[] = [];
    for (let k = ahead; k >= -back; k--) {
      const t = (y * 12 + (m - 1)) + k, yy = Math.floor(t / 12), mm = (t % 12) + 1;
      const p: PeriodInput = { freq: "monthly", fy: 0, q: 0, month: `${yy}-${pad(mm)}`, text: "" };
      out.push({ label: `${MONTHS[mm - 1]} ${yy}`, due: suggestDue(service, p) });
    }
    return out;
  };
  if (s.kind === "bas") {
    const quarters: PeriodOption[] = [];
    let fy = m >= 7 ? y + 1 : y, q = m >= 7 && m <= 9 ? 1 : m >= 10 ? 2 : m <= 3 ? 3 : 4;
    for (let k = 0; k < 6; k++) { // the current quarter and the five before it
      const p: PeriodInput = { freq: "quarterly", fy, q, month: "", text: "" };
      quarters.push({ label: periodLabel(service, p), due: suggestDue(service, p) });
      q--; if (q < 1) { q = 4; fy--; }
    }
    const monthly = months(8, 1).map((o) => ({ ...o, due: suggestDue(service, { freq: "monthly", fy: 0, q: 0, month: monthISO(o.label), text: "" }) }));
    const qg = { label: "Quarterly", options: quarters }, mg = { label: "Monthly", options: monthly };
    return client?.bas_freq === "monthly" ? [mg, qg] : [qg, mg];
  }
  if (s.kind === "monthly") {
    const groups: PeriodGroup[] = [];
    if (service === "payroll" && client?.payroll_anchor && (client.payroll_freq === "weekly" || client.payroll_freq === "fortnightly")) {
      const step = client.payroll_freq === "weekly" ? 7 : 14;
      const dn = (x: string) => { const [a, b, c] = x.split("-").map(Number); return Date.UTC(a, b - 1, c) / 864e5; };
      const a = dn(client.payroll_anchor), t0 = dn(today);
      let n = a + Math.ceil((t0 - a) / step) * step; // next pay day on or after today
      const pays: PeriodOption[] = [];
      for (let k = -6; k <= 3; k++) {
        const d = new Date((n + k * step) * 864e5).toISOString().slice(0, 10);
        if (d < client.payroll_anchor) continue;
        const [dy, dm, dd] = d.split("-").map(Number);
        pays.push({ label: `Pay ${dd} ${MONTHS[dm - 1]} ${dy}`, due: d });
      }
      if (pays.length) groups.push({ label: "Pay days", options: pays.reverse() });
    }
    groups.push({ label: "Months", options: months(8, 1) });
    return groups;
  }
  const fy = currentFY();
  if (s.kind === "annual") return [{ label: "Financial year", options: [fy + 1, fy, fy - 1, fy - 2, fy - 3].map((f) => { const p: PeriodInput = { freq: "quarterly", fy: f, q: 0, month: "", text: "" }; return { label: periodLabel(service, p), due: suggestDue(service, p) }; }) }];
  if (s.kind === "fbt") return [{ label: "FBT year", options: [fy + 1, fy, fy - 1].map((f) => { const p: PeriodInput = { freq: "quarterly", fy: f, q: 0, month: "", text: "" }; return { label: periodLabel(service, p), due: suggestDue(service, p) }; }) }];
  return [];
}
/** "Oct 2026" -> "2026-10" */
export function monthISO(label: string): string {
  const [mon, yr] = label.split(" ");
  const i = MONTHS.indexOf(mon);
  return i < 0 ? "" : `${yr}-${pad(i + 1)}`;
}

/** Once a job is submitted for review, staff can't move its status any more (unless it's sent back to them). */
export const SUBMITTED_STATUSES = new Set(["review", "to_lodge", "sent_for_sign", "lodged", "done"]);
/** Statuses staff can never pick themselves: only the reviewer / signer moves a job there. */
export const STAFF_CANT_PICK = new Set(["to_lodge", "sent_for_sign", "lodged", "done"]);
export function staffSubmittedLock(j: { status: string; reviewer_id?: string | null; sign_owner?: string | null }, meId: string) {
  return SUBMITTED_STATUSES.has(j.status) && j.reviewer_id !== meId && j.sign_owner !== meId;
}
export const SUBMITTED_LOCK_MSG = "Submitted for review. Only the reviewer can change the status now, unless they send it back to you.";
