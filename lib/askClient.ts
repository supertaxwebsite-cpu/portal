"use client";
import { useEffect, useState } from "react";
import type { createClient } from "@/lib/supabase/client";

/** Whether the signed-in person may ask clients (client query, Email client), and their team leader to ask instead.
 *  Master admins and team leaders always may; staff unless a master admin switched it off. */
export function useAskClient(supabase: ReturnType<typeof createClient>, meId: string): { ok: boolean; leader: string | null } {
  const [v, setV] = useState<{ ok: boolean; leader: string | null }>({ ok: true, leader: null });
  useEffect(() => {
    let live = true;
    supabase.from("profiles").select("role, reports_to, can_send_client_query").eq("id", meId).maybeSingle()
      .then(({ data, error }) => {
        if (!live || error || !data) return; // column not added yet: everyone keeps access
        const d = data as { role: string; reports_to: string | null; can_send_client_query?: boolean };
        setV({ ok: d.role !== "staff" || d.can_send_client_query !== false, leader: d.reports_to });
      });
    return () => { live = false; };
  }, [supabase, meId]);
  return v;
}
