"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ClientPicker from "./ClientPicker";
import { parseMeeting, type MeetingDraft } from "@/lib/quickMeeting";

type SB = ReturnType<typeof createClient>;
export interface Meeting {
  id: string; title: string; client_id: string | null; starts_at: string; duration_min: number; location: string; notes: string;
  owner_id: string; attendees: string[]; remind_min: number; done: boolean;
}
interface P { id: string; full_name: string }
interface C { id: string; name: string; abn?: string }

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeOf = (s: string) => new Date(s).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
export const dateOf = (s: string) => new Date(s).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
export const isLink = (s: string) => /^https?:\/\//i.test(s.trim());
const REMIND = [[0, "At start time"], [5, "5 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [1440, "1 day before"]] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Is this person in the meeting (organiser or invited)? */
export const involves = (m: Meeting, id: string) => m.owner_id === id || m.attendees.includes(id);

/* ---------- Meetings page: month calendar + upcoming list ---------- */
/** Colour of a meeting on the calendar: online call, client meeting in the office, or a team meeting. */
const evKind = (m: Meeting) => (isLink(m.location) || /teams|zoom|meet\b|call/i.test(`${m.location} ${m.title}`) ? "online" : m.client_id ? "client" : "team");

export function MeetingsView({ meetings, meId, isMaster, personName, clientName, onBook, onOpen, quick, onAfter, onFollowUp }: {
  meetings: Meeting[]; meId: string; isMaster: boolean; personName: (id: string | null) => string; clientName: (id: string) => string;
  onBook: (date?: string) => void; onOpen: (m: Meeting) => void; quick?: QuickProps;
  /** Save notes after a meeting (to the client's notes) and mark it done. */
  onAfter?: (m: Meeting, notes: string) => Promise<boolean>; onFollowUp?: (m: Meeting) => void;
}) {
  const [after, setAfter] = useState<Record<string, string>>({});
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [mine, setMine] = useState(!isMaster ? true : false);
  const [perm, setPerm] = useState<string>(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  const list = useMemo(() => meetings.filter((m) => !mine || involves(m, meId)), [meetings, mine, meId]);
  const byDay = useMemo(() => { const m = new Map<string, Meeting[]>(); for (const x of list) { const k = dayKey(new Date(x.starts_at)); m.set(k, [...(m.get(k) ?? []), x]); } return m; }, [list]);
  const start = new Date(month); start.setDate(1 - ((month.getDay() + 6) % 7)); // Monday on or before the 1st
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = dayKey(new Date());
  const now = Date.now();
  const upcoming = list.filter((m) => !m.done && new Date(m.starts_at).getTime() + m.duration_min * 60000 >= now).slice(0, 12);
  // Meetings in the last 7 days that are over but not marked done: type quick notes.
  const toWrap = list.filter((m) => !m.done && m.owner_id === meId && new Date(m.starts_at).getTime() + m.duration_min * 60000 < now && now - new Date(m.starts_at).getTime() < 7 * 864e5)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 5);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <>
      <div className="pagehead">
        <div><h1>Meetings</h1><p>Book meetings, invite the team and get a reminder before each one. They also show in My jobs.</p></div>
        <div className="row">
          {perm === "default" ? <button onClick={() => Notification.requestPermission().then(setPerm)}>Turn on desktop alerts</button> : null}
          <button className="primary" onClick={() => onBook()}>Book a meeting</button>
        </div>
      </div>
      <div className="meetgrid">
        <div className="panel cal">
          <div className="calhead">
            <div className="row"><button onClick={() => shift(-1)} aria-label="Previous month">‹</button><button onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button><button onClick={() => shift(1)} aria-label="Next month">›</button></div>
            <h2>{MONTHS[month.getMonth()]} {month.getFullYear()}</h2>
            {isMaster ? <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label> : <span />}
          </div>
          <div className="calgrid">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="dow">{d}</div>)}
            {days.map((d) => { const k = dayKey(d); const ms = byDay.get(k) ?? []; const out = d.getMonth() !== month.getMonth(); return (
              <div key={k} className={`day${out ? " out" : ""}${k === today ? " today" : ""}`} onClick={() => onBook(k)} title="Book a meeting on this day">
                <span className="dnum">{d.getDate()}</span>
                {ms.slice(0, 3).map((m) => <button key={m.id} className={`ev ${evKind(m)}${m.done ? " done" : ""}`} onClick={(e) => { e.stopPropagation(); onOpen(m); }}><b>{timeOf(m.starts_at)}</b> {m.title}</button>)}
                {ms.length > 3 ? <span className="more">+{ms.length - 3} more</span> : null}
              </div>); })}
          </div>
          <div className="evlegend"><span className="ev client">Client meeting</span><span className="ev online">Teams / online</span><span className="ev team">Team meeting</span><span className="note">Click a day to book</span></div>
        </div>
        <div className="meetside">
        {toWrap.length && onAfter ? <div className="panel">
          <div className="ph"><h2>After the meeting</h2><span className="note">Notes go to the client</span></div>
          <ul className="list">{toWrap.map((m) => (
            <li key={m.id} style={{ display: "block" }}>
              <div className="t">{m.title}</div>
              <div className="s">{dateOf(m.starts_at)} · {timeOf(m.starts_at)}{m.client_id ? ` · ${clientName(m.client_id)}` : ""}</div>
              <textarea aria-label="Meeting notes" style={{ marginTop: 6, minHeight: 54 }} placeholder={m.client_id ? "Quick notes, e.g. wants an SMSF set up before 30 June" : "Quick notes (saved on the meeting)"} value={after[m.id] ?? ""} onChange={(e) => setAfter({ ...after, [m.id]: e.target.value })} />
              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="primary" onClick={async () => { if (await onAfter(m, after[m.id] ?? "")) setAfter({ ...after, [m.id]: "" }); }}>{(after[m.id] ?? "").trim() ? "Save notes, mark done" : "Mark done"}</button>
                {m.client_id && onFollowUp ? <button type="button" onClick={() => onFollowUp(m)}>Create follow-up job</button> : null}
              </div>
            </li>))}</ul>
        </div> : null}
        <div className="panel">
          <div className="ph"><h2>Upcoming</h2></div>
          {!upcoming.length ? <div className="empty"><strong>No upcoming meetings.</strong>Click a day on the calendar or Book a meeting.</div> : (
            <ul className="list">{upcoming.map((m) => (
              <li key={m.id}><div style={{ minWidth: 0 }}>
                <div className="t"><button className="link" style={{ color: "var(--fg)", fontWeight: 600 }} onClick={() => onOpen(m)}>{m.title}</button></div>
                <div className="s">{dateOf(m.starts_at)} · {timeOf(m.starts_at)} · {m.duration_min} min{m.client_id ? ` · ${clientName(m.client_id)}` : ""}</div>
                <div className="s">{[personName(m.owner_id), ...m.attendees.filter((a) => a !== m.owner_id).map((a) => personName(a))].filter(Boolean).join(", ")}</div>
              </div>{isLink(m.location) ? <a className="btnlink" href={m.location} target="_blank" rel="noreferrer">Join</a> : null}</li>))}</ul>)}
        </div>
        {quick ? <QuickBook {...quick} meId={meId} personName={personName} clientName={clientName} /> : null}
        </div>
      </div>
    </>
  );
}

/* ---------- Quick book: type a sentence, check the preview, book ---------- */
interface QuickProps { clients: C[]; team: P[]; supabase: SB; say: (m: string, err?: boolean) => void; onSaved: () => void; onEdit: (d: MeetingDraft) => void }
const EXAMPLES = ["Meeting with Sahej Logistics Tuesday 3pm", "Call with Deepa tomorrow 10:30am for 1 hour on Teams", "BAS review with ABC Pty Ltd 14/11 at 2pm in the office"];
function QuickBook({ clients, team, supabase, say, onSaved, onEdit, meId, personName, clientName }: QuickProps & { meId: string; personName: (id: string | null) => string; clientName: (id: string) => string }) {
  const [text, setText] = useState("");
  const [d, setD] = useState<MeetingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const understand = () => { if (text.trim()) setD(parseMeeting(text, clients, team, meId)); };
  async function book() {
    if (!d) return;
    const starts = new Date(`${d.date}T${d.time}`);
    if (starts.getTime() < Date.now() - 60000 && !window.confirm("That time has already passed. Book it anyway?")) return;
    setBusy(true);
    const { error } = await supabase.from("meetings").insert({ title: d.title, client_id: d.client_id || null, starts_at: starts.toISOString(), duration_min: d.duration_min,
      location: d.location, notes: d.notes, attendees: d.attendees, remind_min: 15, owner_id: meId });
    setBusy(false);
    if (error) { say(/row-level security|permission/i.test(error.message) ? "Only master admins and managers can book meetings." : `Not saved: ${error.message}`, true); return; }
    say("Meeting booked"); setText(""); setD(null); onSaved();
  }
  const when = d ? new Date(`${d.date}T${d.time}`) : null;
  return (
    <div className="panel quickbook">
      <div className="ph"><h2>Quick book</h2><span className="note">Type it, we fill it in</span></div>
      <div className="qbbody">
        <textarea id="qb-text" rows={3} value={text} placeholder={`e.g. ${EXAMPLES[0]}`} onChange={(e) => { setText(e.target.value); setD(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); understand(); } }} />
        {!d ? <>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="note">Client name, day and time is enough.</span><button className="primary" disabled={!text.trim()} onClick={understand}>Read it</button></div>
          <div className="qbex">{EXAMPLES.slice(1).map((x) => <button key={x} className="link" onClick={() => { setText(x); setD(parseMeeting(x, clients, team, meId)); }}>{x}</button>)}</div>
        </> : <>
          <dl className="qbprev">
            <dt>Title</dt><dd>{d.title}</dd>
            <dt>Client</dt><dd>{d.client_id ? clientName(d.client_id) : <span className="warn">No client matched</span>}</dd>
            <dt>When</dt><dd>{when ? `${when.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}, ${when.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}` : ""}</dd>
            <dt>Length</dt><dd>{d.duration_min} min</dd>
            {d.location ? <><dt>Where</dt><dd>{d.location}</dd></> : null}
            {d.attendees.length ? <><dt>Invite</dt><dd>{d.attendees.map((a) => personName(a)).join(", ")}</dd></> : null}
          </dl>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button onClick={() => onEdit(d)}>Change details</button>
            <button id="qb-book" className="primary" disabled={busy} onClick={book}>Book it</button>
          </div>
        </>}
      </div>
    </div>
  );
}

/* ---------- Book / edit a meeting ---------- */
export function MeetingModal({ meeting, date, draft, meId, canEdit, team, clients, supabase, say, personName, onClose, onSaved }: {
  meeting?: Meeting; date?: string; draft?: MeetingDraft; meId: string; canEdit: boolean; team: P[]; clients: C[]; supabase: SB;
  say: (m: string, err?: boolean) => void; personName: (id: string | null) => string; onClose: () => void; onSaved: () => void;
}) {
  const s = meeting ? new Date(meeting.starts_at) : null;
  const [v, setV] = useState({
    title: meeting?.title ?? draft?.title ?? "", client_id: meeting?.client_id ?? draft?.client_id ?? "",
    date: s ? dayKey(s) : draft?.date ?? date ?? dayKey(new Date()), time: s ? `${pad(s.getHours())}:${pad(s.getMinutes())}` : draft?.time ?? "10:00",
    duration: String(meeting?.duration_min ?? draft?.duration_min ?? 30), location: meeting?.location ?? draft?.location ?? "", notes: meeting?.notes ?? draft?.notes ?? "",
    attendees: meeting?.attendees ?? draft?.attendees ?? [], remind: String(meeting?.remind_min ?? 15),
  });
  const [busy, setBusy] = useState(false);
  const ro = !!meeting && !canEdit;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const starts = new Date(`${v.date}T${v.time}`);
    if (isNaN(starts.getTime())) { say("Check the date and time.", true); return; }
    setBusy(true);
    const row = { title: v.title.trim(), client_id: v.client_id || null, starts_at: starts.toISOString(), duration_min: Number(v.duration), location: v.location.trim(), notes: v.notes,
      attendees: v.attendees.filter((a) => a !== (meeting?.owner_id ?? meId)), remind_min: Number(v.remind) };
    const { error } = meeting ? await supabase.from("meetings").update(row).eq("id", meeting.id) : await supabase.from("meetings").insert({ ...row, owner_id: meId });
    setBusy(false);
    if (error) { say(/row-level security|permission/i.test(error.message) ? "Only master admins and managers can book meetings." : `Not saved: ${error.message}`, true); return; }
    say(meeting ? "Meeting updated" : "Meeting booked"); onSaved(); onClose();
  }
  async function act(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true); const { error } = await fn(); setBusy(false);
    if (error) { say(`Not saved: ${error.message}`, true); return; }
    say(ok); onSaved(); onClose();
  }
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={submit}>
        <header><h2>{ro ? "Meeting" : meeting ? "Edit meeting" : "Book a meeting"}</h2><button type="button" onClick={onClose}>Close</button></header>
        <div className="body">
          {ro ? <div className="full hint">Booked by {personName(meeting!.owner_id)}. Only they (or a master admin) can change it.</div> : null}
          <label className="f full">Title<input id="mt-title" required disabled={ro} maxLength={200} placeholder="e.g. Tax planning with Deepa" value={v.title} onChange={set("title")} /></label>
          <label className="f full">Client (optional)<ClientPicker id="mt-client" disabled={ro} clients={clients} value={v.client_id} emptyLabel="No client" onChange={(id) => setV({ ...v, client_id: id })} /></label>
          <label className="f">Date<input id="mt-date" type="date" required disabled={ro} value={v.date} onChange={set("date")} /></label>
          <label className="f">Time<input id="mt-time" type="time" required disabled={ro} step={300} value={v.time} onChange={set("time")} /></label>
          <label className="f">Length<select id="mt-dur" disabled={ro} value={v.duration} onChange={set("duration")}>{[15, 30, 45, 60, 90, 120, 180, 240].map((n) => <option key={n} value={n}>{n < 60 ? `${n} min` : `${n / 60} hour${n === 60 ? "" : "s"}`}</option>)}</select></label>
          <label className="f">Reminder<select id="mt-remind" disabled={ro} value={v.remind} onChange={set("remind")}>{REMIND.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></label>
          <label className="f full">Where<input id="mt-where" disabled={ro} placeholder="Office, phone, or a Teams / Zoom / Meet link" value={v.location} onChange={set("location")} /></label>
          <div className="f full"><span>Invite team members</span>
            <div className="row" style={{ marginTop: 6 }}>{team.filter((p) => p.id !== (meeting?.owner_id ?? meId)).map((p) => { const on = v.attendees.includes(p.id); return (
              <label key={p.id} className={`chip ${on ? "on" : ""}`}><input type="checkbox" disabled={ro} checked={on} onChange={() => setV({ ...v, attendees: on ? v.attendees.filter((a) => a !== p.id) : [...v.attendees, p.id] })} />{p.full_name}</label>); })}</div>
            <span className="note" style={{ marginTop: 4 }}>Invited people see it in My jobs and get the reminder too.</span></div>
          <label className="f full">Agenda / notes<textarea id="mt-notes" disabled={ro} value={v.notes} onChange={set("notes")} placeholder="What to prepare, documents needed…" /></label>
          {meeting && isLink(meeting.location) ? <div className="full"><a className="btnlink" href={meeting.location} target="_blank" rel="noreferrer">Join meeting</a></div> : null}
        </div>
        <footer>
          {meeting && !ro ? <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={() => { if (window.confirm("Cancel and delete this meeting?")) act(() => supabase.from("meetings").delete().eq("id", meeting.id), "Meeting deleted"); }}>Delete</button>
            <button type="button" disabled={busy} onClick={() => act(() => supabase.from("meetings").update({ done: !meeting.done }).eq("id", meeting.id), meeting.done ? "Marked not done" : "Marked done")}>{meeting.done ? "Mark not done" : "Mark done"}</button>
          </div> : <span />}
          <div className="row"><button type="button" onClick={onClose}>{ro ? "Close" : "Cancel"}</button>{ro ? null : <button type="submit" className="primary" disabled={busy}>{meeting ? "Save changes" : "Book meeting"}</button>}</div>
        </footer>
      </form>
    </div>
  );
}

/* ---------- Reminders: an in-portal card (and a desktop alert if allowed) ---------- */
export function MeetingReminders({ meetings, meId, clientName, onOpen }: { meetings: Meeting[]; meId: string; clientName: (id: string) => string; onOpen: (m: Meeting) => void }) {
  const [due, setDue] = useState<Meeting[]>([]);
  useEffect(() => {
    const key = (m: Meeting) => `supertax-mtg-${m.id}-${m.starts_at}-${m.remind_min}`;
    const seen = (m: Meeting) => { try { return !!localStorage.getItem(key(m)); } catch { return false; } };
    const check = () => {
      const now = Date.now();
      const list = meetings.filter((m) => {
        if (m.done || !involves(m, meId)) return false;
        const at = new Date(m.starts_at).getTime();
        return now >= at - m.remind_min * 60000 && now < at + m.duration_min * 60000 && !seen(m);
      });
      setDue(list);
      for (const m of list) {
        const fk = `${key(m)}-desktop`;
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted" && !sessionStorage.getItem(fk)) {
            sessionStorage.setItem(fk, "1");
            new Notification(`Meeting at ${timeOf(m.starts_at)}: ${m.title}`, { body: [m.client_id ? clientName(m.client_id) : "", m.location].filter(Boolean).join(" · ") || "Supertax Practice Desk", tag: m.id });
          }
        } catch { /* notifications blocked */ }
      }
    };
    check();
    const t = setInterval(check, 20000);
    return () => clearInterval(t);
  }, [meetings, meId, clientName]);
  const dismiss = (m: Meeting) => { try { localStorage.setItem(`supertax-mtg-${m.id}-${m.starts_at}-${m.remind_min}`, "1"); } catch { /* ignore */ } setDue((d) => d.filter((x) => x.id !== m.id)); };
  if (!due.length) return null;
  return (
    <div className="reminders" role="status">{due.map((m) => { const mins = Math.round((new Date(m.starts_at).getTime() - Date.now()) / 60000); return (
      <div key={m.id} className="reminder">
        <div><strong>{mins > 0 ? `Meeting in ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} min`}` : "Meeting now"}</strong>
          <div>{m.title}</div><small>{timeOf(m.starts_at)}{m.client_id ? ` · ${clientName(m.client_id)}` : ""}{m.location && !isLink(m.location) ? ` · ${m.location}` : ""}</small></div>
        <div className="row">{isLink(m.location) ? <a className="btnlink" href={m.location} target="_blank" rel="noreferrer">Join</a> : null}
          <button onClick={() => onOpen(m)}>Open</button><button onClick={() => dismiss(m)}>Dismiss</button></div>
      </div>); })}</div>
  );
}
