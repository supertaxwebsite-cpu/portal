/** "View as": a master admin sees the portal exactly as a team member would, but nothing can be changed.
 *  Wraps the Supabase client so every write (insert, update, upsert, delete, rpc, file upload or delete)
 *  is refused before it reaches the database. Reads, realtime and the master's own sign-in carry on. */
import type { createClient } from "@/lib/supabase/client";

type SB = ReturnType<typeof createClient>;
export const VIEW_ONLY_MSG = "View only: you're viewing the portal as someone else, so nothing can be changed.";
const refused = { data: null, error: { message: VIEW_ONLY_MSG, code: "VIEWONLY" }, count: null, status: 403, statusText: "View only" };

/** A query chain that accepts any further calls (.eq, .select, .single…) and always ends in the refusal. */
function refusedChain(): unknown {
  const p = Promise.resolve(refused);
  const chain: unknown = new Proxy(function () {}, {
    get(_t, k) {
      if (k === "then") return p.then.bind(p);
      if (k === "catch") return p.catch.bind(p);
      if (k === "finally") return p.finally.bind(p);
      return () => chain;
    },
    apply() { return chain; },
  });
  return chain;
}

const WRITES = new Set(["insert", "update", "upsert", "delete"]);
const FILE_WRITES = new Set(["upload", "update", "remove", "move", "copy", "uploadToSignedUrl"]);

export function viewOnlyClient(sb: SB): SB {
  return new Proxy(sb, {
    get(target, k, recv) {
      if (k === "rpc") return () => refusedChain();
      if (k === "from") return (table: string) => {
        const q = target.from(table);
        return new Proxy(q, { get(qt, m, r) { if (typeof m === "string" && WRITES.has(m)) return () => refusedChain(); const v = Reflect.get(qt, m, r); return typeof v === "function" ? v.bind(qt) : v; } });
      };
      if (k === "storage") {
        const st = target.storage;
        return new Proxy(st, { get(s, m, r) {
          if (m === "from") return (bucket: string) => { const b = s.from(bucket); return new Proxy(b, { get(bt, f, rr) { if (typeof f === "string" && FILE_WRITES.has(f)) return async () => refused; const v = Reflect.get(bt, f, rr); return typeof v === "function" ? v.bind(bt) : v; } }); };
          const v = Reflect.get(s, m, r); return typeof v === "function" ? v.bind(s) : v;
        } });
      }
      const v = Reflect.get(target, k, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as SB;
}

/** While viewing as someone, the portal's own write routes are refused in the browser too (emails, admin changes). */
export function blockApiWrites(): () => void {
  const orig = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const path = (() => { try { return new URL(url, window.location.origin).pathname; } catch { return url; } })();
    if (method !== "GET" && path.startsWith("/api/") && path !== "/api/email/inbox") {
      return Promise.resolve(new Response(JSON.stringify({ error: VIEW_ONLY_MSG }), { status: 403, headers: { "content-type": "application/json" } }));
    }
    return orig(input, init);
  };
  return () => { window.fetch = orig; };
}

/** "View as": the master's own session can read everything, so trim clients and jobs to what the
 *  viewed person's sign-in would show (mirrors can_see_client / can_see_job in the database). */
export function asSeenBy<C extends { id: string; entity?: string | null; practice?: string | null }, J extends { id: string; client_id: string; status: string; assignee_id?: string | null; reviewer_id?: string | null; sign_owner?: string | null; query_from?: string | null }>(
  who: { id: string; role: string; client_types?: string[] | null; practices?: string[] | null }, clients: C[], jobs: J[],
): { clients: C[]; jobs: J[] } {
  if (who.role === "master") return { clients, jobs };
  const mine = (j: J) => j.assignee_id === who.id || j.reviewer_id === who.id || j.sign_owner === who.id || j.query_from === who.id;
  const types = who.client_types ?? [], prac = who.practices ?? [];
  const onJob = new Set(jobs.filter(mine).map((j) => j.client_id));
  const okClient = (c: C) => ((!types.length || types.includes(c.entity ?? "")) && (!prac.length || prac.includes(c.practice ?? ""))) || onJob.has(c.id);
  const seen = clients.filter(okClient);
  const ids = new Set(seen.map((c) => c.id));
  const closed = new Set(["done", "sent_for_sign", "lodged"]);
  const lead = who.role === "manager";
  return { clients: seen, jobs: jobs.filter((j) => mine(j) || (lead && ids.has(j.client_id))
    || (!j.assignee_id && !closed.has(j.status) && ids.has(j.client_id))) };
}
