import "server-only";

/** Sending email from the practice's Microsoft 365 mailbox through Microsoft Graph.
 *  Needs four settings in Vercel: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MAIL_FROM
 *  (an Entra app with the Mail.Send application permission, admin consent given). */
export const mailConfigured = () => !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MAIL_FROM);
export const mailFrom = () => (process.env.MAIL_FROM ?? "").trim();
/** Address put in CC by default (can be changed on each email). */
export const mailCc = () => (process.env.MAIL_CC ?? "info@supertax.com.au").trim();

async function token(): Promise<string> {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID!.trim())}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID!.trim(), client_secret: process.env.MS_CLIENT_SECRET!.trim(),
      scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Microsoft sign-in failed: ${d.error_description?.split("\n")[0] ?? d.error ?? r.status}. Check the email settings in Vercel.`);
  return d.access_token as string;
}

export interface MailFile { name: string; type: string; bytes: Uint8Array }
const SMALL = 3 * 1024 * 1024;

async function graph(t: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const msg = d?.error?.message ?? `HTTP ${r.status}`;
    throw new Error(/Access is denied|ErrorAccessDenied|Authorization_RequestDenied/i.test(msg)
      ? "Microsoft 365 refused to send. Check that the app has the Mail.Send permission with admin consent."
      : `Microsoft 365: ${msg}`);
  }
  return r.status === 202 || r.status === 204 ? null : r.json().catch(() => null);
}

/** Creates a draft in MAIL_FROM's mailbox, attaches the files (large ones in chunks) and sends it.
 *  The email lands in that mailbox's Sent Items, and replies come back to it. */
export async function sendMail(m: { to: string[]; cc: string[]; replyTo?: string; subject: string; html: string; files: MailFile[] }) {
  const t = await token();
  const box = `/users/${encodeURIComponent(mailFrom())}`;
  const addr = (a: string) => ({ emailAddress: { address: a } });
  const draft = await graph(t, `${box}/messages`, { method: "POST", body: JSON.stringify({
    subject: m.subject, body: { contentType: "HTML", content: m.html },
    toRecipients: m.to.map(addr), ccRecipients: m.cc.map(addr), ...(m.replyTo ? { replyTo: [addr(m.replyTo)] } : {}),
  }) }) as { id: string };
  try {
    for (const f of m.files) {
      if (f.bytes.byteLength <= SMALL) {
        await graph(t, `${box}/messages/${draft.id}/attachments`, { method: "POST", body: JSON.stringify({
          "@odata.type": "#microsoft.graph.fileAttachment", name: f.name, contentType: f.type || "application/octet-stream",
          contentBytes: Buffer.from(f.bytes).toString("base64"),
        }) });
      } else {
        const s = await graph(t, `${box}/messages/${draft.id}/attachments/createUploadSession`, { method: "POST", body: JSON.stringify({
          AttachmentItem: { attachmentType: "file", name: f.name, size: f.bytes.byteLength, contentType: f.type || "application/octet-stream" },
        }) }) as { uploadUrl: string };
        const CH = 3 * 1024 * 1024 + 128 * 1024; // multiple of 320 KiB
        for (let i = 0; i < f.bytes.byteLength; i += CH) {
          const part = f.bytes.subarray(i, Math.min(i + CH, f.bytes.byteLength));
          const r = await fetch(s.uploadUrl, { method: "PUT", headers: { "content-length": String(part.byteLength), "content-range": `bytes ${i}-${i + part.byteLength - 1}/${f.bytes.byteLength}` }, body: Buffer.from(part) });
          if (!r.ok) throw new Error(`Couldn't attach ${f.name} (HTTP ${r.status})`);
        }
      }
    }
    await graph(t, `${box}/messages/${draft.id}/send`, { method: "POST" });
  } catch (e) {
    await graph(t, `${box}/messages/${draft.id}`, { method: "DELETE" }).catch(() => null);
    throw e;
  }
}
