"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";
import Workspace from "./Workspace";

const KEY = "pd-view-as";
const roleName = (p: Profile) => (p.role === "manager" ? "Team leader" : p.role === "staff" ? "Team member" : "Master admin");

/** Master admins can open the portal as a team member or team leader sees it (view only), and come back. */
export default function ViewAsRoot({ me }: { me: Profile }) {
  const supabase = useMemo(() => createClient(), []);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [target, setTarget] = useState<Profile | null>(null);
  const [people, setPeople] = useState<Profile[]>([]);
  useEffect(() => { try { setTargetId(sessionStorage.getItem(KEY)); } catch { /* storage blocked */ } }, []);
  const choose = useCallback((id: string | null) => {
    let stored = false;
    try { if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY); stored = true; } catch { /* storage blocked */ }
    // A fresh page load for each switch, so nothing from one person's view carries into the next.
    if (stored) { window.location.hash = ""; window.location.reload(); return; }
    setTarget(null); setTargetId(id); window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    if (me.role !== "master" || !targetId) return;
    let live = true;
    Promise.all([
      supabase.from("profiles").select("*").eq("id", targetId).maybeSingle(),
      supabase.from("profiles").select("*").eq("active", true).neq("role", "master").order("full_name"),
    ]).then(([t, all]) => {
      if (!live) return;
      const p = t.data as Profile | null;
      if (!p || p.role === "master" || !p.active) { choose(null); return; }
      setTarget(p); setPeople((all.data as Profile[] | null) ?? []);
    });
    return () => { live = false; };
  }, [me.role, targetId, supabase, choose]);

  if (me.role !== "master") return <Workspace me={me} />;
  if (targetId && !target) return <div className="wrap" style={{ padding: 40 }}><p className="note">Opening the portal as they see it…</p></div>;
  if (!target) return <Workspace me={me} onViewAs={choose} />;
  return (
    <>
      <div className="viewasbar" role="status">
        <span>👁 Viewing the portal as <b>{target.full_name}</b> · {roleName(target)}. <span className="vo">View only: nothing you click changes anything.</span></span>
        <span className="row" style={{ gap: 6 }}>
          <select aria-label="View as someone else" value={target.id} onChange={(e) => choose(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name} · {roleName(p)}</option>)}
          </select>
          <button type="button" className="primary" onClick={() => choose(null)}>Back to my portal</button>
        </span>
      </div>
      <Workspace key={target.id} me={target} viewer={me} />
    </>
  );
}
