"use client";
import { useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { Person, Profile } from "@/lib/types";
import { fmtDate, todayISO } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
export interface LeaveReq {
  id: string; user_id: string; start_date: string; end_date: string; kind: "unpaid" | "sick" | "personal"; part: "full" | "am" | "pm";
  reason: string; status: "pending" | "approved" | "rejected"; decided_by: string | null; created_at: string;
}
export const LEAVE_KINDS: { id: LeaveReq["kind"]; label: string }[] = [
  { id: "unpaid", label: "Unpaid leave" }, { id: "sick", label: "Sick leave" }, { id: "personal", label: "Personal leave" },
];
export const leaveLabel = (k: string) => LEAVE_KINDS.find((x) => x.id === k)?.label ?? "Leave";
const partLabel = (p: string) => (p === "am" ? "half day (morning)" : p === "pm" ? "half day (afternoon)" : "");
const addDays = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const isWorkDay = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay() !== 0; };
/** Working days (Mon to Sat) a request covers; a half day counts as 0.5. */
export const leaveDays = (r: Pick<LeaveReq, "start_date" | "end_date" | "part">, from = "0000-00-00", to = "9999-99-99") => {
  let n = 0;
  for (let d = r.start_date; d <= r.end_date; d = addDays(d, 1)) if (d >= from && d <= to && isWorkDay(d)) n += r.part === "full" ? 1 : 0.5;
  return n;
};
const span = (r: LeaveReq) => (r.start_date === r.end_date ? fmtDate(r.start_date) : `${fmtDate(r.start_date)} to ${fmtDate(r.end_date)}`);
const StatusPill = ({ s }: { s: LeaveReq["status"] }) => <span className={`pill ${s === "approved" ? "ok" : s === "rejected" ? "danger" : "warn"}`}>{s === "approved" ? "Approved" : s === "rejected" ? "Not approved" : "Waiting for approval"}</span>;

/** Book leave ahead, and see your own requests. */
export function MyLeave({ me, supabase, list, missing, say, onSaved }: { me: Profile; supabase: SB; list: LeaveReq[]; missing: boolean; say: (m: string, e?: boolean) => void; onSaved: () => void }) {
  const [v, setV] = useState({ from: addDays(todayISO(), 1), to: addDays(todayISO(), 1), kind: "unpaid" as LeaveReq["kind"], part: "full" as LeaveReq["part"], reason: "" });
  const [busy, setBusy] = useState(false);
  const mine = list.filter((r) => r.user_id === me.id).sort((a, b) => b.start_date.localeCompare(a.start_date));
  const upcoming = mine.filter((r) => r.end_date >= todayISO());
  const past = mine.filter((r) => r.end_date < todayISO()).slice(0, 5);
  const days = leaveDays({ start_date: v.from, end_date: v.part === "full" ? v.to : v.from, part: v.part });

  async function book(e: React.FormEvent) {
    e.preventDefault();
    const to = v.part === "full" ? v.to : v.from;
    if (!v.from || to < v.from) { say("The end date must be on or after the start date", true); return; }
    if (!days) { say("Those dates are all Sundays, which are already off", true); return; }
    setBusy(true);
    const { error } = await supabase.from("leave_requests").insert({ user_id: me.id, start_date: v.from, end_date: to, kind: v.kind, part: v.part, reason: v.reason.trim() });
    setBusy(false);
    if (error) { say(`Not sent: ${error.message}`, true); return; }
    say("Leave request sent for approval");
    setV({ ...v, reason: "" });
    onSaved();
  }
  async function cancel(r: LeaveReq) {
    if (!window.confirm(`Cancel your ${leaveLabel(r.kind).toLowerCase()} on ${span(r)}?`)) return;
    const { error } = await supabase.from("leave_requests").delete().eq("id", r.id);
    if (error) { say(`Not cancelled: ${error.message}`, true); return; }
    say("Leave cancelled");
    onSaved();
  }

  if (missing) return <div className="panel" style={{ padding: 16 }}><h2 style={{ marginTop: 0 }}>Book leave</h2><p className="note" style={{ margin: 0 }}>Leave booking isn&apos;t switched on yet. Ask your master admin to run the leave database update.</p></div>;
  return (
    <div className="panel" style={{ padding: 16 }} id="book-leave">
      <h2 style={{ marginTop: 0 }}>Book leave</h2>
      <form onSubmit={book} className="leaveform">
        <label className="f">Type<select id="lv-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as LeaveReq["kind"] })}>{LEAVE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
        <label className="f">How long<select id="lv-part" value={v.part} onChange={(e) => setV({ ...v, part: e.target.value as LeaveReq["part"] })}><option value="full">Full day(s)</option><option value="am">Half day (morning)</option><option value="pm">Half day (afternoon)</option></select></label>
        <label className="f">{v.part === "full" ? "From" : "Date"}<input id="lv-from" type="date" required value={v.from} onChange={(e) => setV({ ...v, from: e.target.value, to: e.target.value > v.to ? e.target.value : v.to })} /></label>
        {v.part === "full" ? <label className="f">To<input id="lv-to" type="date" required min={v.from} value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} /></label> : null}
        <label className="f" style={{ gridColumn: "1 / -1" }}>Reason (optional)<input id="lv-reason" value={v.reason} maxLength={1000} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="e.g. Family function" /></label>
        <div className="row" style={{ gridColumn: "1 / -1", justifyContent: "space-between" }}>
          <span className="note">{days ? `${days} working day${days === 1 ? "" : "s"} (Sundays don't count). Your ${me.role === "staff" ? "team leader or master admin" : "master admin"} approves it.` : ""}</span>
          <button type="submit" className="primary" disabled={busy}>Send for approval</button>
        </div>
      </form>
      {upcoming.length || past.length ? (
        <ul className="list" style={{ marginTop: 12 }}>{[...upcoming, ...past].map((r) => (
          <li key={r.id}><div style={{ minWidth: 0 }}><div className="t">{leaveLabel(r.kind)}{r.part !== "full" ? `, ${partLabel(r.part)}` : ""}</div><div className="s">{span(r)} · {leaveDays(r)} day{leaveDays(r) === 1 ? "" : "s"}{r.reason ? ` · ${r.reason}` : ""}</div></div>
            <div className="row"><StatusPill s={r.status} />{r.end_date >= todayISO() && (r.status === "pending" || r.start_date > todayISO()) ? <button type="button" className="link" onClick={() => cancel(r)}>Cancel</button> : null}</div></li>))}</ul>
      ) : <p className="note" style={{ margin: "10px 0 0" }}>No leave booked. There&apos;s no annual leave: choose unpaid, sick or personal leave.</p>}
    </div>
  );
}

/** For master admins and team leaders: approve leave, and see who is off soon. */
export function TeamLeave({ me, supabase, list, visible, people, say, onSaved }: { me: Profile; supabase: SB; list: LeaveReq[]; visible: Profile[]; people: Person[]; say: (m: string, e?: boolean) => void; onSaved: () => void }) {
  const name = (id: string | null) => people.find((p) => p.id === id)?.full_name ?? "Former staff";
  const canApprove = (uid: string) => uid !== me.id && (me.role === "master" || (me.role === "manager" && visible.some((p) => p.id === uid && p.reports_to === me.id)));
  const pending = list.filter((r) => r.status === "pending" && canApprove(r.user_id)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const soon = list.filter((r) => r.status === "approved" && r.end_date >= todayISO() && r.start_date <= addDays(todayISO(), 30) && r.user_id !== me.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
  async function decide(r: LeaveReq, status: "approved" | "rejected") {
    const { error } = await supabase.from("leave_requests").update({ status, decided_by: me.id, decided_at: new Date().toISOString() }).eq("id", r.id);
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    say(status === "approved" ? `Leave approved for ${name(r.user_id)}` : `Leave not approved for ${name(r.user_id)}`);
    onSaved();
  }
  if (!pending.length && !soon.length) return null;
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 12, borderColor: pending.length ? "var(--warn)" : undefined }}>
      {pending.length ? <>
        <h2 style={{ margin: "0 0 8px" }}>Leave waiting for your approval ({pending.length})</h2>
        <table><tbody>{pending.map((r) => (
          <tr key={r.id}><td className="client">{name(r.user_id)}</td><td>{leaveLabel(r.kind)}{r.part !== "full" ? `, ${partLabel(r.part)}` : ""}</td><td>{span(r)} · {leaveDays(r)} day{leaveDays(r) === 1 ? "" : "s"}</td>
            <td style={{ whiteSpace: "pre-wrap" }}>{r.reason || <span className="note">No reason given</span>}</td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}><button type="button" className="primary" onClick={() => decide(r, "approved")}>Approve</button> <button type="button" onClick={() => decide(r, "rejected")}>Don&apos;t approve</button></td></tr>))}</tbody></table>
      </> : null}
      {soon.length ? <>
        <h2 style={{ margin: pending.length ? "14px 0 8px" : "0 0 8px" }}>Who&apos;s off in the next 30 days</h2>
        <ul className="list">{soon.map((r) => <li key={r.id}><div><div className="t">{name(r.user_id)}</div><div className="s">{leaveLabel(r.kind)}{r.part !== "full" ? `, ${partLabel(r.part)}` : ""}</div></div><span className="pill">{span(r)}</span></li>)}</ul>
      </> : null}
    </div>
  );
}
