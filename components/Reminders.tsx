"use client";
import type { Job } from "@/lib/types";
import { svcLabel } from "@/lib/domain";

const DAY = 864e5;
const fmt = (s: string) => new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

/** Signing and client-query reminders, answered right here without opening the job.
 *  A job shows once it has waited 2 days; "Still waiting" hides it for another 2 days. */
export default function Reminders({ jobs, myId, showOwner, clientName, personName, busy, onSigned, onReplied, onWaiting }: {
  jobs: Job[]; myId: string; showOwner: boolean; busy: boolean;
  clientName: (id: string) => string; personName: (id: string | null) => string;
  onSigned: (j: Job) => void; onReplied: (j: Job) => void; onWaiting: (j: Job) => void;
}) {
  const now = Date.now();
  const due = jobs.filter((j) => (j.status === "sent_for_sign" || j.status === "client_query") && j.sign_sent_at
    && now - Date.parse(j.sign_sent_at) >= 2 * DAY && (showOwner || (j.sign_owner ?? j.assignee_id) === myId))
    .sort((a, b) => (a.sign_sent_at ?? "").localeCompare(b.sign_sent_at ?? ""));
  const sign = due.filter((j) => j.status === "sent_for_sign"), query = due.filter((j) => j.status === "client_query");

  const row = (j: Job) => {
    const days = Math.floor((now - Date.parse(j.sign_sent_at!)) / DAY);
    const isSign = j.status === "sent_for_sign";
    const owner = j.sign_owner ?? j.assignee_id;
    return (
      <li key={j.id}>
        <div style={{ minWidth: 0 }}>
          <div className="t"><strong>{clientName(j.client_id)}</strong></div>
          <div className="s">{svcLabel(j.service)} {j.period} · {isSign ? "sent for signing" : "query sent"} {fmt(j.sign_sent_at!)} · <span className="danger">{days} days, no {isSign ? "signature" : "reply"} yet</span>
            {showOwner && owner && owner !== myId ? <> · {personName(owner)}</> : null}</div>
        </div>
        <div className="row actions">
          <button disabled={busy} onClick={() => onWaiting(j)} title="You've chased the client. It comes back in 2 days if nothing changes">Still waiting, remind in 2 days</button>
          {isSign
            ? <button className="primary" disabled={busy} onClick={() => onSigned(j)}>Signed, mark lodged</button>
            : <button className="primary" disabled={busy} onClick={() => onReplied(j)}>Client replied, back to work</button>}
        </div>
      </li>
    );
  };

  return (
    <div className="panel chasebox" id="reminders">
      <div className="ph"><h2>⏰ Reminders{due.length ? ` (${due.length})` : ""}</h2><span className="note">Clients who haven&apos;t signed or replied in 2 days{showOwner ? " (whole practice)" : ""}</span></div>
      {!due.length ? <div className="empty" style={{ padding: "18px 14px" }}><strong>Nothing to chase.</strong>Jobs sent for signing or with a query to the client show here after 2 days with no answer.</div> : <>
        {sign.length ? <><h3 className="remh">Waiting on signature ({sign.length})</h3><ul className="list">{sign.map(row)}</ul></> : null}
        {query.length ? <><h3 className="remh">Waiting on client reply ({query.length})</h3><ul className="list">{query.map(row)}</ul></> : null}
      </>}
    </div>
  );
}
