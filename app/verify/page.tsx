"use client";
import { useEffect, useRef, useState } from "react";
import AuthCard from "@/components/AuthCard";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/nextPath";

/** Second sign-in step: the 6-digit code emailed to the person. */
export default function VerifyPage() {
  const [to, setTo] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("Sending your code…");
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const sent = useRef(false);

  async function send(resend = false) {
    setError(""); setInfo(resend ? "Sending a new code…" : "Sending your code…");
    const r = await fetch(`/api/login-code/send${resend ? "?resend=1" : ""}`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { window.location.href = "/login"; return; }
    if (d.off) { window.location.href = safeNext() || "/"; return; }
    if (!r.ok) { setInfo(""); setError(d.error ?? "The code couldn't be sent. Try again."); return; }
    setTo(d.to ?? ""); setWait(d.wait ?? 60);
    setInfo(resend && d.wait >= 60 ? "A new code is on its way." : "");
  }
  useEffect(() => { if (!sent.current) { sent.current = true; send(); } }, []);
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(t); }, [wait]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await fetch("/api/login-code/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { window.location.href = safeNext() || "/"; return; }
    if (r.status === 401) { window.location.href = "/login"; return; }
    setError(d.error ?? "That didn't work. Try again."); setBusy(false); setCode("");
  }

  return (
    <AuthCard title="Check your email" lead={to ? `We sent a 6-digit code to ${to}. It works for 10 minutes.` : "We're emailing you a 6-digit code."}>
      <form onSubmit={submit} className="stack">
        <label className="f">Sign-in code
          <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus
            style={{ fontSize: 24, letterSpacing: 8, textAlign: "center", fontFamily: "monospace" }}
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : info ? <p className="note">{info}</p> : null}
        <button className="primary big" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Continue"}</button>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button type="button" className="link" disabled={wait > 0} onClick={() => send(true)}>{wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}</button>
          <button type="button" className="link" onClick={async () => { await createClient().auth.signOut(); window.location.href = "/login"; }}>Use another account</button>
        </div>
        <p className="note">No email? Check your junk folder. The code comes from the practice mailbox.</p>
      </form>
    </AuthCard>
  );
}
