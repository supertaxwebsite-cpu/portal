"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { svcLabel } from "@/lib/domain";

type SB = ReturnType<typeof createClient>;
export interface Notice {
  id: string; user_id: string; actor_id: string | null; kind: "job_assigned" | "internal_query" | "query_answered" | "review" | "meeting" | "review_approved" | "review_returned" | "sign_reminder" | "client_query_reminder" | "sign_handover";
  job_id: string | null; meeting_id: string | null; service: string; body: string; read_at: string | null; created_at: string;
}

const WHAT: Record<Notice["kind"], string> = {
  job_assigned: "assigned you a job",
  internal_query: "sent you an internal query",
  query_answered: "sent a job back to you",
  review: "sent you a job to review",
  meeting: "invited you to a meeting",
  review_approved: "approved your job",
  review_returned: "sent a job back to you with changes",
  sign_reminder: "reminder: the client still hasn't signed. Contact them for the signature",
  client_query_reminder: "reminder: no reply yet to your query. Follow up with the client",
  sign_handover: "handed you a job to send to the client for signing",
};

function ago(s: string) {
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** Bell in the top bar: what has been sent to me, newest first, with an unread count. */
export default function Bell({ supabase, meId, personName, onOpen }: {
  supabase: SB; meId: string; personName: (id: string | null) => string; onOpen: (n: Notice) => void;
}) {
  const [items, setItems] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("notifications").select("*").eq("user_id", meId).order("created_at", { ascending: false }).limit(50);
    if (!error) setItems((data as Notice[] | null) ?? []);
  }, [supabase, meId]);

  useEffect(() => {
    load();
    const ch = supabase.channel(`bell-${meId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${meId}` }, () => load())
      .subscribe();
    const t = setInterval(load, 60000); // backup in case live updates drop
    window.addEventListener("focus", load);
    return () => { supabase.removeChannel(ch); clearInterval(t); window.removeEventListener("focus", load); };
  }, [supabase, meId, load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const hide = () => setOpen(false);
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    window.addEventListener("resize", hide); window.addEventListener("scroll", hide);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); window.removeEventListener("resize", hide); window.removeEventListener("scroll", hide); };
  }, [open]);

  const unread = items.filter((n) => !n.read_at).length;
  async function markRead(ids: string[]) {
    if (!ids.length) return;
    const at = new Date().toISOString();
    setItems((xs) => xs.map((n) => (ids.includes(n.id) ? { ...n, read_at: at } : n)));
    await supabase.from("notifications").update({ read_at: at }).in("id", ids);
  }
  async function clearAll() {
    setItems([]);
    await supabase.from("notifications").delete().eq("user_id", meId);
  }

  return (
    <div className="bell" ref={box}>
      <button className="bellbtn" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect(); const w = Math.min(360, window.innerWidth - 32);
        setPos({ top: r.bottom + 8, left: Math.max(16, Math.min(r.right - w, window.innerWidth - 16 - w)), width: w }); setOpen(!open);
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="bellpop" role="dialog" aria-label="Notifications" style={pos ?? undefined}>
          <div className="bellhead">
            <strong>Notifications</strong>
            <div className="row" style={{ gap: 12 }}>
              {unread ? <button className="link" onClick={() => markRead(items.filter((n) => !n.read_at).map((n) => n.id))}>Mark all read</button> : null}
              {items.length ? <button className="link" onClick={() => { if (window.confirm("Clear all your notifications?")) clearAll(); }}>Clear</button> : null}
            </div>
          </div>
          {!items.length ? <div className="bellempty">Nothing yet. When someone assigns you a job, sends you a query or review, or invites you to a meeting, it shows here.</div> : (
            <ul className="belllist">{items.map((n) => (
              <li key={n.id} className={n.read_at ? "" : "unread"}>
                <button onClick={() => { markRead([n.id]); setOpen(false); onOpen(n); }}>
                  <span className="who"><b>{n.actor_id ? personName(n.actor_id) || "Someone" : "Practice Desk"}</b> {WHAT[n.kind] ?? "sent you something"}</span>
                  <span className="what">{n.kind === "meeting" ? n.body : [svcLabel(n.service), n.body].filter(Boolean).join(" · ")}</span>
                  <span className="when">{ago(n.created_at)}</span>
                </button>
              </li>))}</ul>)}
        </div>
      ) : null}
    </div>
  );
}
