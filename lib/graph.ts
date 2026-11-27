import "server-only";

/** Microsoft 365 (Outlook) mailboxes, read and sent through Microsoft Graph with the portal's own app sign-in.
 *  Microsoft no longer accepts mailbox passwords for this, so the portal uses an app registered in Microsoft Entra:
 *    MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET  (Mail.ReadWrite and Mail.Send application permissions, admin consented)
 *  Messages get a number (uid) so the rest of the Inbox works the same as with IMAP:
 *  the second it arrived × 1000, plus 0–999 from its id. The number finds the message again. */

export const graphReady = () => !!(env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET"));
function env(k: string) { return (process.env[k] ?? "").trim(); }
// Overridable only so a test copy can point at a stand-in server.
const LOGIN = () => env("MS_LOGIN_BASE") || "https://login.microsoftonline.com";
const GRAPH = () => env("MS_GRAPH_BASE") || "https://graph.microsoft.com";

let tok: { v: string; exp: number } | null = null;
async function token(): Promise<string> {
  if (tok && tok.exp > Date.now() + 60_000) return tok.v;
  const r = await fetch(`${LOGIN()}/${encodeURIComponent(env("MS_TENANT_ID"))}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const d = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !d.access_token) throw new Error(`Microsoft didn't accept the portal's sign-in. Check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in Vercel (${(d.error_description ?? r.statusText).split("\r")[0].slice(0, 160)}).`);
  tok = { v: d.access_token, exp: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return tok.v;
}

/** One Graph call for a mailbox. `path` starts after /users/{mailbox}. */
export async function g(user: string, path: string, init: RequestInit & { raw?: boolean } = {}): Promise<Response> {
  const r = await fetch(`${GRAPH()}/v1.0/users/${encodeURIComponent(user)}${path}`, {
    ...init, headers: { authorization: `Bearer ${await token()}`, prefer: 'IdType="ImmutableId"', ...(init.headers ?? {}) },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    let m = t; try { m = (JSON.parse(t) as { error?: { message?: string } }).error?.message ?? t; } catch { /* not json */ }
    if (r.status === 401 || r.status === 403) throw new Error(`${user}: Microsoft refused access (${m.slice(0, 160)}). Check the app has Mail.ReadWrite and Mail.Send with admin consent.`);
    if (r.status === 404) throw Object.assign(new Error(`${user}: not found in Microsoft 365 (${m.slice(0, 120)})`), { notFound: true });
    throw new Error(`${user}: Microsoft 365 error ${r.status} (${m.slice(0, 160)})`);
  }
  return r;
}
export const gj = async <T>(user: string, path: string, init?: RequestInit) => (await (await g(user, path, init)).json()) as T;

function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 1000; }
export const uidOf = (when: string, id: string) => Math.floor(Date.parse(when) / 1000) * 1000 + hash(id);

export interface GMsg { id: string; subject?: string; receivedDateTime: string; isRead?: boolean; hasAttachments?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } }; toRecipients?: { emailAddress?: { name?: string; address?: string } }[] }
export const SEL = "id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments";
export const folderOf = (f: string) => (f === "sent" ? "sentitems" : "inbox");

/** The Graph id of the message with this uid, or null. */
export async function idOf(user: string, folder: string, uid: number): Promise<string | null> {
  const s = Math.floor(uid / 1000) * 1000;
  const from = new Date(s).toISOString(), to = new Date(s + 1000).toISOString();
  const d = await gj<{ value: GMsg[] }>(user, `/mailFolders/${folderOf(folder)}/messages?$select=id,receivedDateTime&$top=50&$filter=${encodeURIComponent(`receivedDateTime ge ${from} and receivedDateTime lt ${to}`)}`);
  return d.value.find((m) => uidOf(m.receivedDateTime, m.id) === uid)?.id ?? null;
}

/** The whole email (MIME), to read with mailparser like an IMAP message. */
export async function mimeOf(user: string, id: string): Promise<Buffer> {
  return Buffer.from(await (await g(user, `/messages/${encodeURIComponent(id)}/$value`)).arrayBuffer());
}

/** Pages through a Graph list, up to `max` messages. */
export async function pages(user: string, path: string, max: number): Promise<GMsg[]> {
  const out: GMsg[] = [];
  let next: string | null = path;
  while (next && out.length < max) {
    const d: { value: GMsg[]; "@odata.nextLink"?: string } = /^https?:\/\//.test(next)
      ? await (await fetch(next, { headers: { authorization: `Bearer ${await token()}`, prefer: 'IdType="ImmutableId"' } })).json()
      : await gj(user, next);
    out.push(...(d.value ?? []));
    next = d["@odata.nextLink"] ?? null;
  }
  return out.slice(0, max);
}
