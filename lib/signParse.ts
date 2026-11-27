/** Reading Zoho Sign "has been completed" emails and finding the job they belong to.
 *  Document names look like ITR_SUKHDEVSINGHCHAHAL, CTR_DEEPCREATIVEPTYLTD_FY26 or BAS_PRIMECONTAINER_Q1FY27. */

const CODES: Record<string, string> = {
  ITR: "itr", IR: "itr", IND: "itr", INDIVIDUAL: "itr", TAX: "itr",
  CTR: "ctr", CO: "ctr", COMPANY: "ctr",
  TTR: "trust", TRUST: "trust", TR: "trust",
  PTR: "partnership", PARTNERSHIP: "partnership",
  SMSF: "smsf", FS: "fin", FIN: "fin", BAS: "bas", IAS: "ias", FBT: "fbt", TPAR: "tpar",
};

/** Is this email a Zoho Sign completion? Returns the document name, or null. */
export function completedDoc(from: string, subject: string): string | null {
  if (!/zoho/i.test(from)) return null;
  const s = subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim();
  const m = s.match(/^(?:document\s+)?["'“‘]?(.+?)["'”’]?\s+(?:has been|is|was)\s+completed\b/i)
    ?? s.match(/^completed\s*[:\-–]\s*["'“‘]?(.+?)["'”’]?$/i)
    ?? s.match(/^["'“‘]?(.+?)["'”’]?\s*[-–:]\s*completed$/i);
  return m ? m[1].trim().slice(0, 200) : null;
}

export const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const PERIOD = /^(FY\d{2}(\d{2})?|Q[1-4](FY)?\d{2}(\d{2})?|\d{4}|(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}(\d{2})?)$/i;

export interface DocParts { service: string | null; name: string; period: string | null }
export function parseDoc(doc: string): DocParts {
  const toks = doc.replace(/\.pdf$/i, "").split(/[_\s\-–.]+/).filter(Boolean);
  let service: string | null = null;
  if (toks.length > 1 && CODES[toks[0].toUpperCase()]) service = CODES[toks.shift()!.toUpperCase()];
  let period: string | null = null;
  while (toks.length > 1 && PERIOD.test(toks[toks.length - 1])) period = norm(toks.pop()!) + (period ?? "");
  return { service, name: norm(toks.join("")), period };
}

/** "FY26" and "FY2026" are the same year. */
const periodKey = (p: string) => norm(p).replace(/FY20(\d{2})/g, "FY$1").replace(/^20(\d{2})$/, "FY$1");

export interface MatchJob { id: string; client_id: string; service: string; period: string; status: string; sign_reminded_at: string | null }
export interface MatchClient { id: string; name: string }

/** Clients whose name is the document's name (ignoring spaces, dots and capitals; "Pty Ltd" may be left off). */
export function clientsFor(name: string, clients: MatchClient[]): MatchClient[] {
  if (name.length < 3) return [];
  const exact = clients.filter((c) => norm(c.name) === name);
  if (exact.length) return exact;
  const strip = (n: string) => n.replace(/(PTYLTD|PTYLIMITED|LIMITED|LTD|PTY|SUPERFUND|SMSF|TRUST|FAMILYTRUST)+$/, "");
  return clients.filter((c) => { const cn = norm(c.name); return name.length >= 5 && (strip(cn) === name || strip(cn) === strip(name) || (cn.startsWith(name) && name.length >= cn.length * 0.6)); });
}

/** Jobs out for signing that this document could be: the client, then the service, then the period if one is given. */
export function candidates(doc: DocParts, clients: MatchClient[], jobs: MatchJob[], signedMark: string): { open: MatchJob[]; done: MatchJob[] } {
  const ids = new Set(clientsFor(doc.name, clients).map((c) => c.id));
  let all = jobs.filter((j) => ids.has(j.client_id) && (!doc.service || j.service === doc.service));
  if (doc.period) { const p = periodKey(doc.period); const byP = all.filter((j) => periodKey(j.period).includes(p)); if (byP.length) all = byP; }
  const open = all.filter((j) => j.status === "sent_for_sign" && j.sign_reminded_at !== signedMark);
  const done = all.filter((j) => !open.includes(j));
  return { open, done };
}
