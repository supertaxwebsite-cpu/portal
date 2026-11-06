"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Signs the person out after 20 minutes with no activity in any open portal tab.
 *  A warning shows for the last minute so they can stay signed in. */
export const IDLE_KEY = "supertax-last-activity";
const IDLE_MS = 20 * 60 * 1000;
const WARN_MS = 60 * 1000;

const readLast = () => { try { return Number(localStorage.getItem(IDLE_KEY)) || 0; } catch { return 0; } };
export const markActive = () => { try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch { /* storage blocked */ } };

export default function IdleSignOut() {
  const [left, setLeft] = useState<number | null>(null);
  const last = useRef(Date.now());
  const done = useRef(false);

  useEffect(() => {
    // Sign-in records the time, so an old time here means the portal was left idle
    // (for example the computer slept) and it signs out straight away.
    const stored = readLast();
    if (stored) last.current = stored; else markActive();

    let wrote = 0;
    const active = () => {
      if (done.current) return;
      const now = Date.now();
      last.current = now;
      if (now - wrote > 5000) { wrote = now; markActive(); }
    };
    const signOut = async () => {
      if (done.current) return;
      done.current = true;
      try { await createClient().auth.signOut(); } catch { /* signed out locally anyway */ }
      window.location.href = "/login?idle=1";
    };
    const tick = () => {
      const latest = Math.max(last.current, readLast());
      const idle = Date.now() - latest;
      if (idle >= IDLE_MS) { signOut(); return; }
      setLeft(idle >= IDLE_MS - WARN_MS ? Math.ceil((IDLE_MS - idle) / 1000) : null);
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, active, { passive: true }));
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    const t = setInterval(tick, 1000);
    return () => { clearInterval(t); events.forEach((e) => window.removeEventListener(e, active)); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  if (left === null) return null;
  return (
    <div className="overlay" style={{ zIndex: 60 }} role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
      <div className="modal" style={{ maxWidth: 420 }}>
        <header><h2 id="idle-title">Are you still there?</h2></header>
        <div className="body"><p className="full" style={{ margin: 0 }}>For security, you&apos;ll be signed out in <strong>{left} second{left === 1 ? "" : "s"}</strong> because there&apos;s been no activity for almost 20 minutes.</p></div>
        <footer><span /><button type="button" className="primary" autoFocus onClick={() => { markActive(); setLeft(null); }}>Stay signed in</button></footer>
      </div>
    </div>
  );
}
