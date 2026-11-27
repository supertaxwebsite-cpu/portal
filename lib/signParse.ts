/** Reading Zoho Sign "has been completed" emails and finding the job they belong to.
 *  Document names look like ITR_SUKHDEVSINGHCHAHAL, CTR_DEEPCREATIVEPTYLTD_FY26 or BAS_PRIMECONTAINER_Q1FY27. */

const CODES: Record<string, string> = {
  ITR: "itr", IR: "itr", IND: "itr", INDIVIDUAL: "itr", TAX: "itr",
  CTR: "ctr", CO: "ctr", COMPANY: "ctr",
  TTR: "trust", TRUST: "trust", TR: "trust",
  PTR: "partnership", PARTNERSHIP: "partnership",
  SMSF: "smsf", FS: "fin", FIN: "fin", BAS: "bas", AS: "bas", IAS: "ias", FBT: "fbt", TPAR: "tpar",
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
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH = /^(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)(\d{2}|\d{4})?$/;

/** service: the job type, or null. periods: ways the job's period could be written (any one matching is enough). */
export interface DocParts { service: string | null; name: string; periods: string[] }
/** Splits a document name into service, client name and period, wherever they sit:
 *  ITR_SUKHDEVSINGHCHAHAL, 2026_ITR_RAMANJEETCHAHAL, workpaper_Q1_2027, 2026_September_AS_NMAUPTYLTD, BAS_PRIMECONTAINER_Q1FY27. */
export function parseDoc(doc: string): DocParts {
  const toks = doc.replace(/\.pdf$/i, "").replace(/\(\d+\)/g, " ").split(/[_\s\-–.]+/).filter(Boolean);
  let service: string | null = null, quarter = "", year = "", fy = "", month = -1;
  const rest: string[] = [];
  for (const raw of toks) {
    const t = raw.toUpperCase();
    let m: RegExpMatchArray | null;
    if (!service && CODES[t] && toks.length > 1 && !(rest.length && ["TAX", "TR", "CO", "IND"].includes(t))) { service = CODES[t]; continue; }
    if ((m = t.match(/^Q([1-4])(?:FY)?(\d{2}|\d{4})?$/))) { quarter = m[1]; if (m[2]) fy = m[2].slice(-2); continue; }
    if ((m = t.match(/^FY(\d{2}|\d{4})$/))) { fy = m[1].slice(-2); continue; }
    if ((m = t.match(/^(20\d{2})$/))) { year = m[1].slice(-2); continue; }
    if ((m = t.match(MONTH))) { month = MONTHS.indexOf(m[1].slice(0, 3)); if (m[2]) year = m[2].slice(-2); continue; }
    rest.push(raw);
  }
  const periods: string[] = [];
  if (month >= 0) {
    // A month: the monthly period (Sep 2026), and the BAS quarter it falls in (Sep 2026 is Q1 FY27).
    const y = year || fy;
    if (y) {
      periods.push(`${MONTHS[month]}20${y}`);
      const f = String(Number(y) + (month >= 6 ? 1 : 0)).padStart(2, "0");
      periods.push(`Q${[3, 3, 3, 4, 4, 4, 1, 1, 1, 2, 2, 2][month]}FY${f}`);
    } else periods.push(MONTHS[month]);
  } else if (quarter) periods.push(`Q${quarter}${fy || year ? `FY${fy || year}` : ""}`);
  else if (fy || year) periods.push(`FY${fy || year}`);
  return { service, name: norm(rest.join("")), periods };
}

/** "FY26", "FY2026" and "2026" are the same year; "Q1 FY27" and "Q1 2027" become Q1FY27; "Oct 2026" stays OCT2026. */
const periodKey = (p: string) => norm(p).replace(/FY20(\d{2})/g, "FY$1").replace(/^(Q[1-4])?20(\d{2})$/, "$1FY$2")
  .replace(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*(\d{4})$/, "$1$2");

export interface MatchJob { id: string; client_id: string; service: string; period: string; status: string; sign_reminded_at: string | null }
export interface MatchClient { id: string; name: string }

/** Clients whose name is the document's name (ignoring spaces, dots and capitals; "Pty Ltd" may be left off). */
export function clientsFor(name: string, clients: MatchClient[]): MatchClient[] {
  if (name.length < 3) return [];
  const exact = clients.filter((c) => norm(c.name) === name);
  if (exact.length) return exact;
  const strip = (n: string) => n.replace(/(PTYLTD|PTYLIMITED|LIMITED|LTD|PTY|SUPERFUND|SMSF|TRUST|FAMILYTRUST)+$/, "");
  const close = clients.filter((c) => { const cn = norm(c.name); return name.length >= 5 && (strip(cn) === name || strip(cn) === strip(name) || (cn.startsWith(name) && name.length >= cn.length * 0.6)); });
  if (close.length || name.length < 5) return close;
  // Short names: some of the client's words in order, starting with the first.
  // "workpaper" for Workpaper Solutions Pty Ltd, "RAMANJEETCHAHAL" for Ramanjeet Singh Chahal.
  const fits = (words: string[], i: number, left: string): boolean => {
    if (!left) return true;
    for (let k = i; k < words.length; k++) if (left.startsWith(words[k]) && fits(words, k + 1, left.slice(words[k].length))) return true;
    return false;
  };
  return clients.filter((c) => {
    const words = c.name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).slice(0, 8);
    return words.length > 0 && name.startsWith(words[0]) && fits(words, 1, name.slice(words[0].length));
  });
}

/** Jobs out for signing that this document could be: the client, then the service, then the period if one is given. */
export function candidates(doc: DocParts, clients: MatchClient[], jobs: MatchJob[], signedMark: string): { open: MatchJob[]; done: MatchJob[] } {
  const ids = new Set(clientsFor(doc.name, clients).map((c) => c.id));
  let all = jobs.filter((j) => ids.has(j.client_id) && (!doc.service || j.service === doc.service || (doc.service === "bas" && j.service === "ias")));
  // The closest way of writing the period that matches wins (a monthly Sep 2026 job before the Q1 FY27 quarter).
  for (const p of doc.periods) { const byP = all.filter((j) => periodKey(j.period).includes(p)); if (byP.length) { all = byP; break; } }
  const open = all.filter((j) => j.status === "sent_for_sign" && j.sign_reminded_at !== signedMark);
  const done = all.filter((j) => !open.includes(j));
  return { open, done };
}
