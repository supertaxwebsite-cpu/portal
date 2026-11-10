import { DEFAULT_PRACTICE, ENTITIES, PRACTICES, SERVICES } from "./domain";
import type { Client, Person } from "./types";

export interface ImportRow {
  line: number; // spreadsheet row number, for messages
  practice: string;
  name: string;
  entity: string;
  abn: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
  manager_id: string | null;
  services: string[];
  bas_freq: "quarterly" | "monthly" | "annual";
  notes: string;
}

export interface ImportCheck {
  ready: ImportRow[];
  skipped: { line: number; name: string; reason: string }[];
  problems: { line: number; name: string; reason: string }[];
  warnings: { line: number; name: string; reason: string }[];
}

type Field = "practice" | "address" | "street" | "suburb" | "state" | "postcode" | "name" | "entity" | "abn" | "contact" | "email" | "phone" | "manager" | "services" | "bas" | "notes";

const HEADERS: Record<Field, string[]> = {
  practice: ["practice", "practice name", "firm"],
  address: ["address", "full address", "postal address", "business address", "street address"],
  street: ["street", "address line 1", "address 1", "street address line"],
  suburb: ["suburb", "city", "town", "suburb / city"],
  state: ["state"],
  postcode: ["postcode", "post code", "postal code", "zip"],
  name: ["client name", "client", "name", "client / entity name", "entity name"],
  entity: ["entity type", "entity", "type"],
  abn: ["abn"],
  contact: ["contact person", "contact", "contact name"],
  email: ["email", "email address", "e-mail"],
  phone: ["phone", "phone number", "mobile", "telephone"],
  manager: ["manager", "client manager"],
  services: ["services", "service"],
  bas: ["bas cycle", "bas frequency", "bas"],
  notes: ["notes", "note", "comments"],
};

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Read a CSV file's text into rows of cells (handles quotes, commas and new lines in cells). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function matchService(raw: string): string | null {
  const k = key(raw);
  if (!k) return null;
  const exact = SERVICES.find((s) => key(s.label) === k || key(s.id) === k);
  if (exact) return exact.id;
  const starts = SERVICES.filter((s) => key(s.label).startsWith(k) || k.startsWith(key(s.label)));
  return starts.length === 1 ? starts[0].id : null;
}

/** Check uploaded rows against the template and the clients already in the portal. */
export function checkImport(table: unknown[][], existing: Client[], people: Person[], practice: string = DEFAULT_PRACTICE): ImportCheck | { error: string } {
  const headerAt = table.findIndex((r) => r.some((c) => norm(c)));
  if (headerAt < 0) return { error: "The file is empty." };
  const header = table[headerAt].map((c) => key(norm(c)));
  const col = {} as Record<Field, number>;
  (Object.keys(HEADERS) as Field[]).forEach((f) => { col[f] = header.findIndex((h) => HEADERS[f].some((a) => key(a) === h)); });
  if (col.name < 0) return { error: "Couldn't find a \"Client name\" column. Use the template and keep its first row of headings." };

  const names = new Set(existing.map((c) => key(c.name)));
  const abns = new Set(existing.map((c) => c.abn.replace(/\D/g, "")).filter(Boolean));
  const people_ = new Map(people.filter((p) => p.active).map((p) => [key(p.full_name), p.id]));
  const out: ImportCheck = { ready: [], skipped: [], problems: [], warnings: [] };

  table.slice(headerAt + 1).forEach((r, i) => {
    const line = headerAt + i + 2;
    const get = (f: Field) => (col[f] >= 0 ? norm(r[col[f]]) : "");
    if (!r.some((c) => norm(c))) return;
    const name = get("name");
    if (/^example\b/i.test(name)) return;
    if (!name) { out.problems.push({ line, name: "(no name)", reason: "Client name is empty" }); return; }

    const abn = get("abn");
    const abnDigits = abn.replace(/\D/g, "");
    if (names.has(key(name))) { out.skipped.push({ line, name, reason: "A client with this name already exists" }); return; }
    if (abnDigits && abns.has(abnDigits)) { out.skipped.push({ line, name, reason: "A client with this ABN already exists" }); return; }

    const entRaw = get("entity");
    const entity = entRaw ? ENTITIES.find((e) => key(e) === key(entRaw)) : "Company";
    if (!entity) { out.problems.push({ line, name, reason: `Entity type "${entRaw}" isn't one of: ${ENTITIES.join(", ")}` }); return; }

    const basKey = key(get("bas"));
    const basRaw = ["annual", "annually", "yearly"].includes(basKey) ? "annual" : basKey;
    if (basRaw && basRaw !== "quarterly" && basRaw !== "monthly" && basRaw !== "annual") { out.problems.push({ line, name, reason: "BAS cycle must be Quarterly, Monthly or Annually" }); return; }

    const services: string[] = [];
    const unknown: string[] = [];
    get("services").split(/[,;|\n]/).map((s) => s.trim()).filter(Boolean).forEach((s) => {
      const id = matchService(s);
      if (id) { if (!services.includes(id)) services.push(id); } else unknown.push(s);
    });
    if (unknown.length) { out.problems.push({ line, name, reason: `Unknown service: ${unknown.join(", ")}` }); return; }

    const pracRaw = get("practice");
    const prac = pracRaw ? PRACTICES.find((p) => key(p) === key(pracRaw) || key(p).startsWith(key(pracRaw))) : practice;
    if (!prac) { out.problems.push({ line, name, reason: `Practice "${pracRaw}" isn't one of: ${PRACTICES.join(", ")}` }); return; }

    // One Address column, or separate Street / Suburb / State / Postcode columns joined together.
    const full = get("address");
    const parts = [get("street"), [get("suburb"), get("state"), get("postcode")].filter(Boolean).join(" ")].filter(Boolean);
    const address = full && parts.length ? [full, ...parts.filter((p) => !full.includes(p))].join(", ") : full || parts.join(", ");

    const mgrRaw = get("manager");
    const manager_id = mgrRaw ? people_.get(key(mgrRaw)) ?? null : null;
    if (mgrRaw && !manager_id) out.warnings.push({ line, name, reason: `No team member called "${mgrRaw}", so no manager will be set` });
    if (abnDigits && abnDigits.length !== 11) out.warnings.push({ line, name, reason: "ABN isn't 11 digits; it'll be saved as written" });

    names.add(key(name));
    if (abnDigits) abns.add(abnDigits);
    out.ready.push({
      line, practice: prac, name, entity, abn, contact: get("contact"), email: get("email"), phone: get("phone"), address,
      manager_id, services, bas_freq: basRaw === "monthly" || basRaw === "annual" ? basRaw : "quarterly", notes: get("notes"),
    });
  });
  return out;
}
