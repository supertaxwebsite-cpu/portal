import { NextResponse } from "next/server";
import { currentProfile } from "@/lib/auth";
import { boxes, withImap, sentPath, type Box } from "@/lib/mailboxes";
import type { ImapFlow, FetchMessageObject } from "imapflow";
import { g, idOf, mimeOf, pages, uidOf, SEL, folderOf, type GMsg } from "@/lib/graph";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Inbox for the practice mailboxes: read, search, reply and send. Master admins only for now. */
const allowed = async () => { const me = await currentProfile(); return me && me.role === "master" ? me : null; };
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

interface Head { box: number; folder: "inbox" | "sent"; uid: number; from: { name: string; address: string }; to: string[]; subject: string; date: string; seen: boolean; att: boolean }

const addr = (a?: { name?: string; address?: string }[]) => (a ?? []).map((x) => (x.address ?? "").toLowerCase()).filter(Boolean);
function head(b: Box, folder: Head["folder"], m: FetchMessageObject): Head {
  const f = m.envelope?.from?.[0];
  const hasAtt = (n?: FetchMessageObject["bodyStructure"]): boolean => !!n && (n.disposition === "attachment" || (n.childNodes ?? []).some(hasAtt));
  return { box: b.i, folder, uid: m.uid, from: { name: f?.name ?? "", address: (f?.address ?? "").toLowerCase() }, to: addr(m.envelope?.to),
    subject: m.envelope?.subject ?? "(no subject)", date: new Date(m.envelope?.date ?? m.internalDate ?? Date.now()).toISOString(),
    seen: !!m.flags?.has("\\Seen"), att: hasAtt(m.bodyStructure) };
}
function gHead(b: Box, folder: Head["folder"], m: GMsg): Head {
  const f = m.from?.emailAddress;
  return { box: b.i, folder, uid: uidOf(m.receivedDateTime, m.id), from: { name: f?.name ?? "", address: (f?.address ?? "").toLowerCase() },
    to: (m.toRecipients ?? []).map((x) => (x.emailAddress?.address ?? "").toLowerCase()).filter(Boolean),
    subject: m.subject || "(no subject)", date: new Date(m.receivedDateTime).toISOString(), seen: folder === "sent" || !!m.isRead, att: !!m.hasAttachments };
}
const kql = (s: string) => s.replace(/["\\]/g, " ").trim();
async function listGraph(b: Box, folder: Head["folder"], q: string, limit: number): Promise<Head[]> {
  const path = `/mailFolders/${folderOf(folder)}/messages?$select=${SEL}&$top=${limit}&` + (q ? `$search=${encodeURIComponent(`"${kql(q)}"`)}` : "$orderby=receivedDateTime%20desc");
  return (await pages(b.user, path, limit)).map((m) => gHead(b, folder, m));
}
/** One mailbox, either kind. */
const listBox = (b: Box, folder: Head["folder"], q: string, limit: number) => (b.kind === "graph" ? listGraph(b, folder, q, limit) : withImap(b, (c) => listFolder(c, b, folder, q, limit)));

const FETCH = { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true } as const;

async function openFolder(c: ImapFlow, folder: string) {
  const path = folder === "sent" ? await sentPath(c) : "INBOX";
  if (!path) return null;
  return c.getMailboxLock(path);
}

/** The newest `limit` messages in a folder, optionally only those matching `q` (sender, recipient or subject). */
async function listFolder(c: ImapFlow, b: Box, folder: Head["folder"], q: string, limit: number): Promise<Head[]> {
  const lock = await openFolder(c, folder);
  if (!lock) return [];
  try {
    let uids: number[] = (await c.search(q ? { or: [{ from: q }, { to: q }, { subject: q }] } : { all: true }, { uid: true })) || [];
    uids = uids.sort((x, y) => x - y).slice(-limit);
    if (!uids.length) return [];
    const out: Head[] = [];
    for await (const m of c.fetch(uids.join(","), FETCH, { uid: true })) out.push(head(b, folder, m));
    return out;
  } finally { lock.release(); }
}

function pick(i: string | null) { const b = boxes().find((x) => String(x.i) === i); return b ?? null; }

export async function GET(req: Request) {
  if (!(await allowed())) return bad("Only master admins can open the practice mailboxes.", 403);
  const u = new URL(req.url);
  const a = u.searchParams.get("a");
  const all = boxes();
  if (a === "boxes") return NextResponse.json({ boxes: all.map((b) => ({ i: b.i, address: b.user })) });
  try {
    if (a === "list") {
      const folder = u.searchParams.get("folder") === "sent" ? "sent" : "inbox";
      const q = (u.searchParams.get("q") ?? "").trim().slice(0, 100);
      const which = u.searchParams.get("box");
      const list = which && which !== "all" ? all.filter((b) => String(b.i) === which) : all;
      const errors: string[] = [];
      const res = await Promise.all(list.map((b) => listBox(b, folder, q, 60).catch((e) => { errors.push((e as Error).message); return [] as Head[]; })));
      return NextResponse.json({ messages: res.flat().sort((x, y) => y.date.localeCompare(x.date)).slice(0, 150), errors });
    }
    if (a === "client") {
      // Everything to or from a client's email addresses, in every mailbox (inbox and sent).
      const emails = (u.searchParams.get("emails") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x)).slice(0, 5);
      if (!emails.length) return NextResponse.json({ messages: [], errors: [] });
      const errors: string[] = [];
      const res = await Promise.all(all.map((b) => (b.kind === "graph" ? (async () => {
        const search = encodeURIComponent(`"${emails.map((e) => `participants:${kql(e)}`).join(" OR ")}"`);
        const out: Head[] = [];
        for (const folder of ["inbox", "sent"] as const) out.push(...(await pages(b.user, `/mailFolders/${folderOf(folder)}/messages?$select=${SEL}&$top=40&$search=${search}`, 40)).map((m) => gHead(b, folder, m)));
        return out;
      })() : withImap(b, async (c) => {
        const out: Head[] = [];
        for (const folder of ["inbox", "sent"] as const) {
          const lock = await openFolder(c, folder);
          if (!lock) continue;
          try {
            const crit = emails.flatMap((e) => [{ from: e }, { to: e }, { cc: e }]);
            const uids = ((await c.search(crit.length === 1 ? crit[0] : { or: crit }, { uid: true })) || []).sort((x, y) => x - y).slice(-40);
            if (uids.length) for await (const m of c.fetch(uids.join(","), FETCH, { uid: true })) out.push(head(b, folder, m));
          } finally { lock.release(); }
        }
        return out;
      })).catch((e) => { errors.push((e as Error).message); return [] as Head[]; })));
      return NextResponse.json({ messages: res.flat().sort((x, y) => y.date.localeCompare(x.date)).slice(0, 100), errors });
    }
    if (a === "msg" || a === "att") {
      const b = pick(u.searchParams.get("box"));
      const uid = Number(u.searchParams.get("uid"));
      const folder = u.searchParams.get("folder") === "sent" ? "sent" : "inbox";
      if (!b || !uid) return bad("That email couldn't be found.");
      const { simpleParser } = await import("mailparser");
      const gone = () => bad("That email couldn't be found. It may have been moved or deleted.", 404);
      let source: Buffer | null = null;
      let gid: string | null = null;
      if (b.kind === "graph") {
        gid = await idOf(b.user, folder, uid);
        if (!gid) return gone();
        source = await mimeOf(b.user, gid);
      } else {
        source = await withImap(b, async (c) => {
          const lock = await openFolder(c, folder);
          if (!lock) return null;
          try {
            const m = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
            if (m && m.source && a === "msg" && folder === "inbox") await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => null);
            return m && m.source ? m.source : null;
          } finally { lock.release(); }
        });
      }
      if (!source) return gone();
      const p = await simpleParser(source);
      const atts = p.attachments.filter((x) => x.contentDisposition !== "inline" || !x.cid);
      if (a === "att") {
        const f = atts[Number(u.searchParams.get("i"))];
        if (!f) return bad("That attachment couldn't be found.", 404);
        const name = (f.filename || "attachment").replace(/[\r\n"]/g, "");
        return new NextResponse(new Uint8Array(f.content), { headers: { "content-type": f.contentType || "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } });
      }
      if (gid && folder === "inbox") await g(b.user, `/messages/${encodeURIComponent(gid)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isRead: true }) }).catch(() => null);
      const list = (x: typeof p.to) => (Array.isArray(x) ? x : x ? [x] : []).flatMap((gr) => gr.value.map((v) => ({ name: v.name ?? "", address: (v.address ?? "").toLowerCase() })));
      // Inline images: put them into the HTML so it shows as sent.
      let html = typeof p.html === "string" ? p.html : "";
      for (const x of p.attachments) if (x.cid && html.includes(`cid:${x.cid}`)) html = html.split(`cid:${x.cid}`).join(`data:${x.contentType};base64,${x.content.toString("base64")}`);
      return NextResponse.json({
        box: b.i, folder, uid, subject: p.subject ?? "(no subject)", date: (p.date ?? new Date()).toISOString(),
        from: list(p.from)[0] ?? { name: "", address: "" }, replyTo: list(p.replyTo)[0]?.address ?? "", to: list(p.to), cc: list(p.cc),
        messageId: p.messageId ?? "", references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
        html: html.slice(0, 1_500_000), text: (p.text ?? "").slice(0, 200_000),
        attachments: atts.map((x, i) => ({ i, name: x.filename || `attachment-${i + 1}`, size: x.size, type: x.contentType })),
      });
    }
  } catch (e) { return bad((e as Error).message, 502); }
  return bad("Unknown request.");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

export async function POST(req: Request) {
  if (!(await allowed())) return bad("Only master admins can send from the practice mailboxes.", 403);
  const fd = await req.formData().catch(() => null);
  if (!fd) return bad("Nothing to send.");
  const a = String(fd.get("a") ?? "send");
  const b = pick(String(fd.get("box") ?? ""));
  if (!b) return bad("Choose which mailbox to use.");
  if (a === "unseen") {
    const uid = Number(fd.get("uid"));
    if (b.kind === "graph") {
      const id = await idOf(b.user, "inbox", uid);
      if (id) await g(b.user, `/messages/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isRead: false }) });
      return NextResponse.json({ ok: true });
    }
    await withImap(b, async (c) => { const l = await c.getMailboxLock("INBOX"); try { await c.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true }); } finally { l.release(); } });
    return NextResponse.json({ ok: true });
  }
  const split = (k: string) => String(fd.get(k) ?? "").split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean);
  const to = split("to"), cc = split("cc");
  if (!to.length) return bad("Add who it's to.");
  const badA = [...to, ...cc].find((x) => !EMAIL.test(x));
  if (badA) return bad(`"${badA}" isn't an email address.`);
  if (to.length + cc.length > 20) return bad("That's too many people for one email.");
  const subject = String(fd.get("subject") ?? "").slice(0, 300);
  const text = String(fd.get("body") ?? "").slice(0, 100_000);
  const quote = String(fd.get("quote") ?? "").slice(0, 200_000);
  const files = fd.getAll("file").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
  if (files.reduce((t, f) => t + f.size, 0) > 4 * 1024 * 1024) return bad("Attachments can be up to 4 MB in total here. For bigger files, use the Dropbox folder.");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">${esc(text).replace(/\n/g, "<br>")}</div>${quote ? `<br><blockquote style="margin:0 0 0 8px;border-left:2px solid #ccc;padding-left:8px;color:#555">${esc(quote).replace(/\n/g, "<br>")}</blockquote>` : ""}`;
  const plain = quote ? `${text}\n\n${quote.split("\n").map((l) => `> ${l}`).join("\n")}` : text;
  const inReplyTo = String(fd.get("inReplyTo") ?? "").slice(0, 500) || undefined;
  const references = String(fd.get("references") ?? "").slice(0, 4000) || undefined;
  const mail = {
    from: { name: process.env.MAIL_NAME?.trim() || "Supertax", address: b.user }, to, cc: cc.length ? cc : undefined, subject, html, text: plain, inReplyTo, references,
    attachments: await Promise.all(files.map(async (f) => ({ filename: f.name, content: Buffer.from(await f.arrayBuffer()), contentType: f.type || undefined }))),
  };
  if (b.kind === "graph") {
    // Microsoft 365: send the finished email through Graph; it lands in Sent Items like any Outlook email.
    try {
      const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
      const mime: Buffer = await new MailComposer(mail).compile().build();
      await g(b.user, "/sendMail", { method: "POST", headers: { "content-type": "text/plain" }, body: mime.toString("base64") });
    } catch (e) { return bad(`Email not sent: ${(e as Error).message}`, 502); }
    return NextResponse.json({ ok: true });
  }
  const nodemailer = (await import("nodemailer")).default;
  const t = nodemailer.createTransport({ host: b.smtp, port: b.smtpPort, secure: b.smtpPort !== 587 && b.smtpPort !== 25, auth: { user: b.user, pass: b.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  try {
    await t.sendMail(mail);
  } catch (e) {
    const msg = (e as Error).message;
    return bad(/auth|535|credentials|password/i.test(msg) ? `${b.user}: the mail server didn't accept the sign-in. Check its app password in Vercel.` : `Email not sent: ${msg}`, 502);
  }
  return NextResponse.json({ ok: true });
}
