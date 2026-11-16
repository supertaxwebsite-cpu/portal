"use client";
import type { Job } from "@/lib/types";
import { svcLabel } from "@/lib/domain";

export interface MailRow { job_id: string; direction: string | null; created_at: string; from_addr: string | null; subject: string; body: string; files: string[] | null }
export interface Reply { job: Job; mail: MailRow; count: number }

/** Jobs waiting on a client query where the client has emailed back since our last email. Newest first. */
export function newReplies(mail: MailRow[], jobs: Job[]): Reply[] {
  const byJob = new Map<string, { out: string; ins: MailRow[] }>();
  for (const m of mail) {
    const e = byJob.get(m.job_id) ?? { out: "", ins: [] };
    if (m.direction === "in") e.ins.push(m); else if (m.created_at > e.out) e.out = m.created_at;
    byJob.set(m.job_id, e);
  }
  const out: Reply[] = [];
  for (const j of jobs) {
    if (j.status !== "client_query") continue;
    const e = byJob.get(j.id);
    const fresh = e?.ins.filter((m) => m.created_at > e.out) ?? [];
    if (fresh.length) out.push({ job: j, mail: fresh[fresh.length - 1], count: fresh.length });
  }
  return out.sort((a, b) => b.mail.created_at.localeCompare(a.mail.created_at));
}

const ago = (t: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};
const snippet = (b: string) => { const t = b.replace(/\s+/g, " ").trim(); return t.length > 160 ? `${t.slice(0, 160)}…` : t; };

/** Overview panel: client replies that came in by email, with a one-click move back to processing. */
export default function ClientReplies({ list, clientName, personName, busy, onOpen, onReplied, title = "Client replied" }: {
  list: Reply[]; clientName: (id: string) => string; personName: (id: string | null) => string; busy?: boolean;
  onOpen: (j: Job) => void; onReplied: (j: Job) => void; title?: string;
}) {
  if (!list.length) return null;
  return (
    <div className="panel creplies">
      <div className="ph"><h2>✉ {title} <span className="pill ok">{list.length}</span></h2><span className="note">The client emailed back. Read it on the job, then press Client replied to start processing</span></div>
      <ul className="list">{list.map(({ job: j, mail: m, count }) => {
        const files = m.files?.length ?? 0;
        return (
          <li key={j.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="t"><button type="button" className="link jobname" onClick={() => onOpen(j)}>{clientName(j.client_id)} · {svcLabel(j.service)} {j.period}</button></div>
              <div className="s">{m.from_addr || "Client"} · {ago(m.created_at)}{count > 1 ? ` · ${count} emails` : ""}{files ? ` · 📎 ${files} file${files === 1 ? "" : "s"}` : ""}{j.assignee_id ? ` · ${personName(j.assignee_id)}` : " · Unassigned"}</div>
              {m.body.trim() ? <div className="crsnip">{snippet(m.body)}</div> : null}
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              <button type="button" onClick={() => onOpen(j)}>Read reply</button>
              <button type="button" className="primary" disabled={busy} onClick={() => onReplied(j)}>Client replied</button>
            </div>
          </li>);
      })}</ul>
    </div>
  );
}
