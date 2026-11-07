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
  { id: "to_lodge", label: "Ready to lodge", cls: "accent", open: true },
  { id: "sent_for_sign", label: "Sent for sign", cls: "warn", open: true },
  { id: "lodged", label: "Lodged", cls: "ok", open: false },
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

export const roleLabel = (r: string) => (r === "master" ? "Master admin" : r === "manager" ? "Manager" : "Staff");

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
