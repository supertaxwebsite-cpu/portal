/** Finds existing clients that look like the one being added (same ABN, same name, or one name inside the other). */
interface C { id: string; name: string; abn?: string | null }

const SUFFIX = new Set(["pty", "ltd", "limited", "proprietary", "the", "trust", "trustee", "trustees", "for", "atf", "as", "and", "co", "company", "inc", "incorporated", "group", "family", "superannuation", "super", "fund", "smsf"]);
export const coreName = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !SUFFIX.has(w)).join(" ");
const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "");

export interface Similar { client: C; why: string }

export function similarClients(name: string, abn: string, clients: C[], excludeId?: string): Similar[] {
  const n = coreName(name);
  const a = digits(abn);
  const out: Similar[] = [];
  for (const c of clients) {
    if (c.id === excludeId) continue;
    const cn = coreName(c.name);
    const ca = digits(c.abn);
    if (a.length >= 9 && a === ca) { out.push({ client: c, why: "Same ABN" }); continue; }
    if (!n || !cn) continue;
    if (n === cn) { out.push({ client: c, why: "Same name" }); continue; }
    const [short, long] = n.length <= cn.length ? [n, cn] : [cn, n];
    if (short.length >= 3 && ` ${long} `.includes(` ${short} `)) out.push({ client: c, why: "Similar name" });
  }
  return out.slice(0, 5);
}
