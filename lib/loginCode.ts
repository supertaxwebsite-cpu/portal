/** Email code at sign-in (second step after the password).
 *  After the right code, a signed cookie marks this sign-in session as checked.
 *  The cookie is tied to the Supabase session id, so every new sign-in needs a new code.
 *  Works in middleware (edge) and route handlers: uses Web Crypto only. */

export const CODE_COOKIE = "pd_code_ok";
export const CODE_TTL_MIN = 10;
export const CODE_MAX_TRIES = 5;
export const CODE_RESEND_SEC = 60;
const COOKIE_HOURS = 14;

/** On only when LOGIN_CODE=on is set in Vercel AND the portal can send email; otherwise nobody could get in. */
export const codeStepOn = () =>
  process.env.LOGIN_CODE === "on" &&
  !!((process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) ||
    (process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MAIL_FROM));

const secret = () => (process.env.LOGIN_CODE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Hash of a code for storing: never keep the code itself. */
export const hashCode = (userId: string, code: string) => hmac(`code:${userId}:${code}`);

/** The session id inside a Supabase access token (not verified here: only used after getUser()). */
export function sessionIdOf(accessToken?: string | null): string | null {
  try {
    const part = (accessToken ?? "").split(".")[1];
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.session_id === "string" ? json.session_id : null;
  } catch {
    return null;
  }
}

export async function makeCookie(userId: string, sessionId: string): Promise<{ value: string; maxAge: number }> {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_HOURS * 3600;
  const body = `${userId}.${sessionId}.${exp}`;
  return { value: `${body}.${await hmac(body)}`, maxAge: COOKIE_HOURS * 3600 };
}

export async function cookieOk(value: string | undefined, userId: string, sessionId: string | null): Promise<boolean> {
  if (!value || !sessionId || !secret()) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [u, s, exp, sig] = parts;
  if (u !== userId || s !== sessionId || Number(exp) * 1000 < Date.now()) return false;
  const want = await hmac(`${u}.${s}.${exp}`);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function newCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, "0");
}
