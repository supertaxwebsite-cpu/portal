/** Turns a sentence like "Meeting with Sahej Logistics Tuesday 3pm for 1 hour on Teams" into meeting details.
 *  Runs in the browser; used on its own, or as a fallback when the AI service isn't set up. */
export interface MeetingDraft { title: string; client_id: string; date: string; time: string; duration_min: number; location: string; attendees: string[]; notes: string }
interface C { id: string; name: string }
interface P { id: string; full_name: string }

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const STOP = new Set(["pty", "ltd", "limited", "the", "and", "trust", "trustee", "for", "of", "family", "group", "services", "australia", "co"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function matchClient(text: string, clients: C[]): C | null {
  const t = ` ${norm(text)} `;
  let best: { c: C; score: number } | null = null;
  for (const c of clients) {
    const n = norm(c.name);
    let score = 0;
    if (n && t.includes(` ${n} `)) score = 100 + n.length;
    else {
      const words = n.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
      const hit = words.filter((w) => t.includes(` ${w} `));
      if (hit.length) score = (hit.length / words.length) * 50 + hit.join("").length;
    }
    if (score > 0 && (!best || score > best.score)) best = { c, score };
  }
  return best && best.score >= 8 ? best.c : null;
}

export function parseMeeting(text: string, clients: C[], team: P[], meId: string, now = new Date()): MeetingDraft {
  const raw = text.trim();
  const t = raw.toLowerCase();
  const client = matchClient(raw, clients);
  // Date
  let date: Date | null = null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/\btoday\b|\btonight\b/.test(t)) date = today;
  else if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) date = new Date(today.getTime() + 864e5);
  else if (/\bday after tomorrow\b/.test(t)) date = new Date(today.getTime() + 2 * 864e5);
  let m: RegExpMatchArray | null;
  if (!date && (m = t.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
    date = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && date < today) date = new Date(y + 1, Number(m[2]) - 1, Number(m[1]));
  }
  if (!date && (m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/) ?? null)) {
    const y = m[3] ? Number(m[3]) : now.getFullYear();
    date = new Date(y, MON.indexOf(m[2]), Number(m[1]));
    if (!m[3] && date < today) date.setFullYear(y + 1);
  }
  if (!date && (m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/) ?? null)) {
    const y = m[3] ? Number(m[3]) : now.getFullYear();
    date = new Date(y, MON.indexOf(m[1]), Number(m[2]));
    if (!m[3] && date < today) date.setFullYear(y + 1);
  }
  if (!date && (m = t.match(/\b(next\s+|this\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|sday|urday|rsday)?\b/))) {
    const want = DAYS.findIndex((d) => d.startsWith(m![2].slice(0, 3)));
    let add = (want - today.getDay() + 7) % 7;
    if (add === 0) add = 7;
    if (m[1]?.trim() === "next" && add < 7) add += 0; // "next Tuesday" = the coming Tuesday
    date = new Date(today.getTime() + add * 864e5);
  }
  if (!date && /\bnext week\b/.test(t)) date = new Date(today.getTime() + ((8 - today.getDay()) % 7 || 7) * 864e5);
  // Time
  let time = "";
  if ((m = t.match(/\b(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/))) {
    let h = Number(m[1]) % 12; if (m[3].startsWith("p")) h += 12;
    time = `${pad(h)}:${m[2] ?? "00"}`;
  } else if ((m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/))) time = `${pad(Number(m[1]))}:${m[2]}`;
  else if ((m = t.match(/\bat\s+(\d{1,2})\b(?!\s*(min|minute|hour|hr|h\b|\/))/))) { let h = Number(m[1]); if (h >= 1 && h <= 6) h += 12; time = `${pad(h)}:00`; }
  else if (/\bnoon|midday\b/.test(t)) time = "12:00";
  else if (/\bmorning\b/.test(t)) time = "09:30";
  else if (/\bafternoon\b/.test(t)) time = "14:00";
  else if (/\btonight|evening\b/.test(t)) time = "18:00";
  // If only a time was given and it's already passed today, use tomorrow.
  if (!date) {
    date = today;
    if (time) { const [h, mi] = time.split(":").map(Number); if (h * 60 + mi <= now.getHours() * 60 + now.getMinutes()) date = new Date(today.getTime() + 864e5); }
  }
  // Length
  let duration = 30;
  if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h)\b/))) duration = Math.round(Number(m[1]) * 60);
  else if ((m = t.match(/\b(\d+)\s*(minutes|minute|mins|min|m)\b/))) duration = Number(m[1]);
  else if (/\bhalf (an )?hour\b/.test(t)) duration = 30;
  else if (/\ban hour\b|\bone hour\b/.test(t)) duration = 60;
  duration = Math.min(720, Math.max(5, duration));
  // Where
  const url = raw.match(/https?:\/\/\S+/)?.[0] ?? "";
  const location = url || (/\bteams\b/.test(t) ? "Microsoft Teams" : /\bzoom\b/.test(t) ? "Zoom" : /\bgoogle meet\b|\bmeet\b/.test(t) ? "Google Meet" : /\b(phone|call)\b/.test(t) ? "Phone call"
    : /\b(office|in person|our office)\b/.test(t) ? "Office" : /\b(their|client'?s?) (office|place|site)\b/.test(t) ? "Client's office" : "");
  // Team members mentioned
  const tn = ` ${norm(raw)} `;
  const attendees = team.filter((p) => p.id !== meId && norm(p.full_name).split(" ").some((w) => w.length >= 3 && tn.includes(` ${w} `))).map((p) => p.id);
  // Title
  const purpose = raw.match(/\b(about|re|regarding|for|to discuss)\s+([^,.;]+)/i)?.[2]?.replace(/\b(at|on|tomorrow|today|tonight|next|this|with|from|in|\d)\b.*$/i, "").trim();
  const lead = raw.replace(/^(please\s+)?(book|schedule|set up|arrange|create)\s+(an?\s+)?/i, "").match(/^(.{3,40}?)\s+with\s+/i)?.[1]?.trim();
  const what = purpose && purpose.length > 3 && !/^\d/.test(purpose) ? purpose : lead || "Meeting";
  const title = client ? `${what[0].toUpperCase()}${what.slice(1)} – ${client.name}`
    : raw.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").slice(0, 120) || "Meeting";
  return { title, client_id: client?.id ?? "", date: ymd(date), time: time || "10:00", duration_min: duration, location, attendees, notes: "" };
}
