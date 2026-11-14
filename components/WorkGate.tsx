"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type { JobTimer } from "@/lib/types";

type SB = ReturnType<typeof createClient>;
interface Shift { id: string; clock_in: string }

/** Minutes a logged-in staff member can go without a job running before the "sitting idle" message. */
export const IDLE_WORK_MIN = 10;
const IDLE_MS = IDLE_WORK_MIN * 60 * 1000;
const STOP_KEY = "pd-last-job-stop";
const readStop = () => { try { return Number(localStorage.getItem(STOP_KEY)) || 0; } catch { return 0; } };
const writeStop = (t: number) => { try { localStorage.setItem(STOP_KEY, String(t)); } catch { /* storage blocked */ } };

/** For staff only:
 *  - until they Log in (Timesheet), the portal shows only a Log in screen (the Timesheet page stays open);
 *  - once logged in, if no job is running for 10 minutes, a message asks them to start their assigned work. */
export default function WorkGate({ supabase, meId, isStaff, running, onTimesheet, onMyJobs, say, children }: {
  supabase: SB; meId: string; isStaff: boolean; running: JobTimer | null; onTimesheet: boolean;
  onMyJobs: () => void; say: (m: string, err?: boolean) => void; children: React.ReactNode;
}) {
  const [shift, setShift] = useState<Shift | null | undefined>(undefined); // undefined = not known yet
  const [busy, setBusy] = useState(false);
  const [idle, setIdle] = useState(false);
  const snoozed = useRef(0);
  const wasRunning = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("attendance").select("id, clock_in").eq("user_id", meId).is("clock_out", null).order("clock_in", { ascending: false }).limit(1);
    if (error) { setShift(undefined); return; } // can't tell: don't lock anyone out
    setShift(((data as Shift[] | null) ?? [])[0] ?? null);
  }, [supabase, meId]);

  useEffect(() => {
    if (!isStaff) return;
    load();
    const ch = supabase.channel(`my-shift-${meId}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `user_id=eq.${meId}` }, () => load())
      .subscribe();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); supabase.removeChannel(ch); };
  }, [supabase, meId, isStaff, load]);

  // Remember when the last job was stopped (kept across page reloads).
  useEffect(() => {
    const now = !!running;
    if (wasRunning.current === true && !now) writeStop(Date.now());
    if (now) { setIdle(false); writeStop(Date.now()); }
    wasRunning.current = now;
  }, [running]);

  useEffect(() => {
    if (!isStaff || !shift || running) { setIdle(false); return; }
    const check = () => {
      const since = Math.max(Date.parse(shift.clock_in), readStop(), snoozed.current);
      if (Date.now() - since >= IDLE_MS) setIdle(true);
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [isStaff, shift, running]);

  async function logIn() {
    setBusy(true);
    const { error } = await supabase.rpc("clock_in");
    setBusy(false);
    if (error) { say(`That didn't work: ${error.message}`, true); return; }
    writeStop(Date.now()); // the idle count starts from logging in
    say("Logged in. Have a good day!");
    await load();
  }

  if (isStaff && shift === null && !onTimesheet) {
    return (
      <div className="panel workgate">
        <div className="wg-icon" aria-hidden>🕘</div>
        <h2>Log in to start work</h2>
        <p>You haven&apos;t logged in for work today. Log in first, then your jobs, clients and payroll open up.</p>
        <button type="button" className="primary big" style={{ width: "auto" }} disabled={busy} onClick={logIn}>{busy ? "Logging in…" : "Log in"}</button>
        <p className="note">Your log-in time goes on your attendance. You log out from the Timesheet page at the end of the day.</p>
      </div>
    );
  }

  return <>
    {children}
    {idle ? (
      <div className="overlay" role="alertdialog" aria-labelledby="idle-h">
        <div className="modal idlebox">
          <div className="body" style={{ display: "block", textAlign: "center", padding: "26px 22px" }}>
            <div className="wg-icon" aria-hidden>⏳</div>
            <h2 id="idle-h" style={{ margin: "6px 0 8px" }}>You are sitting idle</h2>
            <p style={{ margin: "0 0 18px" }}>No job has been running for {IDLE_WORK_MIN} minutes or more. Please start the work on your assigned job.</p>
            <div className="row" style={{ justifyContent: "center" }}>
              <button type="button" className="primary" onClick={() => { snoozed.current = Date.now(); setIdle(false); onMyJobs(); }}>Go to my jobs</button>
              <button type="button" onClick={() => { snoozed.current = Date.now(); setIdle(false); }}>Remind me in {IDLE_WORK_MIN} min</button>
            </div>
          </div>
        </div>
      </div>
    ) : null}
  </>;
}
