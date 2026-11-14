/** Office rules by work location. Each person works from one location (profiles.work_location). */
export type Location = "India" | "Australia";
export interface Office {
  location: Location;
  tz: string;
  /** Office start, minutes after midnight local time. */
  start: number;
  /** Logging in after this (minutes after midnight) is Late. */
  lateAfter: number;
  /** Minutes logged in for a full day (work plus break). */
  shiftMin: number;
  /** Hours of work in a full day. */
  workDayH: number;
  /** A finished day under this many minutes logged in is a Half day. */
  halfDayMin: number;
  /** Working days of the week, 0 = Sunday. */
  days: number[];
  hoursText: string;
  daysText: string;
}
export const OFFICES: Record<Location, Office> = {
  India: { location: "India", tz: "Asia/Kolkata", start: 7 * 60 + 30, lateAfter: 7 * 60 + 45, shiftMin: 9 * 60, workDayH: 8.25, halfDayMin: 6 * 60, days: [1, 2, 3, 4, 5, 6],
    hoursText: "7:30 am to 4:30 pm (India time) with a 45 min break, so 8h 15m a day", daysText: "Mon to Sat" },
  Australia: { location: "Australia", tz: "Australia/Sydney", start: 9 * 60, lateAfter: 9 * 60 + 15, shiftMin: 8 * 60 + 30, workDayH: 7.75, halfDayMin: 5 * 60 + 30, days: [1, 2, 3, 4, 5],
    hoursText: "9:00 am to 5:30 pm (Sydney time) with a 45 min break, so 7h 45m a day", daysText: "Mon to Fri" },
};
export const LOCATIONS = Object.keys(OFFICES) as Location[];
export const officeOf = (p: { work_location?: string | null } | null | undefined): Office => OFFICES[(p?.work_location as Location) ?? "India"] ?? OFFICES.India;

/** Minutes after midnight in the office's time zone. */
export const localMinutes = (ts: string, o: Office) => {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: o.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const n = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return n("hour") * 60 + n("minute");
};
/** Today's date (YYYY-MM-DD) in the office's time zone. */
export const localDay = (o: Office, at: Date = new Date()) => at.toLocaleDateString("en-CA", { timeZone: o.tz });
/** Clock time (e.g. 7:42 am) in the office's time zone. */
export const localTime = (ts: string | null | undefined, o: Office) => (ts ? new Date(ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: o.tz }) : "");
/** The instant (ms) of 23:59:59 on a date in the office's time zone. */
export const dayEndMs = (date: string, o: Office) => {
  const guess = Date.parse(`${date}T23:59:59Z`);
  if (isNaN(guess)) return NaN;
  // Offset of the zone at that moment, worked out from how the zone prints it.
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: o.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return guess - (asUtc - guess);
};
export const isWorkDay = (d: string, o: Office) => { const [y, m, dd] = d.split("-").map(Number); return o.days.includes(new Date(Date.UTC(y, m - 1, dd)).getUTCDay()); };
/** When someone should log out: a full shift after they started (or after the office start if they came in early). */
export const suggestedOutFor = (firstIn: string, o: Office) => {
  const t = Date.parse(firstIn);
  const base = Math.max(t, t - (localMinutes(firstIn, o) - o.start) * 60000);
  return new Date(base + o.shiftMin * 60000).toISOString();
};
export const clockText = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return `${h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")}`; };
