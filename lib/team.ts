import type { createAdminClient } from "@/lib/supabase/admin";

/** Make exactly these staff members report to the team leader `leaderId`. Returns an error message, or null. */
export async function setTeam(admin: ReturnType<typeof createAdminClient>, leaderId: string, team: unknown): Promise<string | null> {
  if (!Array.isArray(team)) return null;
  const ids = team.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x) && x !== leaderId);
  const { error: e1 } = await admin.from("profiles").update({ reports_to: null }).eq("reports_to", leaderId).not("id", "in", `(${ids.length ? ids.join(",") : "00000000-0000-0000-0000-000000000000"})`);
  if (e1) return e1.message;
  if (ids.length) {
    const { error: e2 } = await admin.from("profiles").update({ reports_to: leaderId }).in("id", ids).eq("role", "staff");
    if (e2) return e2.message;
  }
  return null;
}
