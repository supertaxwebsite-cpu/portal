import "server-only";
import type { ImapFlow } from "imapflow";

/** Practice mailboxes shown in the Inbox tab and checked for Zoho Sign emails. Passwords live only in Vercel:
 *    MAILBOX_1_USER = accounting@mysupertax.com.au
 *    MAILBOX_1_PASS = the mailbox's app password
 *  Add more later as MAILBOX_2_USER / MAILBOX_2_PASS, MAILBOX_3_…, and so on.
 *  The mail server is the same as the portal's own (IMAP_HOST, or SMTP_HOST with "smtp" changed to "imap");
 *  if a mailbox is with another provider, also set MAILBOX_n_IMAP_HOST and MAILBOX_n_SMTP_HOST. */
export interface Box { i: number; user: string; pass: string; imap: string; imapPort: number; smtp: string; smtpPort: number }

export function boxes(): Box[] {
  const env = (k: string) => (process.env[k] ?? "").trim();
  const smtp0 = env("SMTP_HOST");
  const imap0 = env("IMAP_HOST") || smtp0.replace(/^smtp/i, "imap");
  const out: Omit<Box, "i">[] = [];
  for (let n = 1; n <= 9; n++) {
    const user = env(`MAILBOX_${n}_USER`), pass = env(`MAILBOX_${n}_PASS`);
    if (!user || !pass || out.some((b) => b.user.toLowerCase() === user.toLowerCase())) continue;
    const smtp = env(`MAILBOX_${n}_SMTP_HOST`) || smtp0;
    const imap = env(`MAILBOX_${n}_IMAP_HOST`) || (env(`MAILBOX_${n}_SMTP_HOST`) ? smtp.replace(/^smtp/i, "imap") : imap0);
    if (!imap) continue;
    out.push({ user: user.toLowerCase(), pass, imap, imapPort: Number(env(`MAILBOX_${n}_IMAP_PORT`) || 993), smtp, smtpPort: Number(env(`MAILBOX_${n}_SMTP_PORT`) || env("SMTP_PORT") || 465) });
  }
  return out.map((b, i) => ({ ...b, i }));
}

export async function withImap<T>(b: Box, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({ host: b.imap, port: b.imapPort, secure: true, auth: { user: b.user, pass: b.pass }, logger: false, socketTimeout: 30000 });
  try {
    await c.connect();
  } catch (e) {
    const m = (e as Error & { authenticationFailed?: boolean }).authenticationFailed || /auth|login|credentials/i.test((e as Error).message);
    throw new Error(m ? `${b.user}: the mail server didn't accept the sign-in. Check MAILBOX app password in Vercel.` : `${b.user}: couldn't reach the mail server ${b.imap} (${(e as Error).message}).`);
  }
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}

/** The mailbox's Sent folder, whatever the service calls it. */
export async function sentPath(c: ImapFlow): Promise<string | null> {
  const list = await c.list();
  return (list.find((f) => f.specialUse === "\\Sent") ?? list.find((f) => /^(sent|sent items|sent mail|sent messages)$/i.test(f.name)))?.path ?? null;
}
