"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/AuthCard";
import { createClient } from "@/lib/supabase/client";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 10) { setMsg("Use at least 10 characters."); return; }
    if (pw !== confirm) { setMsg("The two passwords don't match."); return; }
    setBusy(true); setMsg("");
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setMsg(error.message); setBusy(false); return; }
    if (user) await supabase.from("profiles").update({ must_change_password: false }).eq("id", user.id);
    router.replace("/");
    router.refresh();
  }

  return (
    <AuthCard title="Choose your password" lead="Replace the temporary password with one only you know.">
      <form onSubmit={submit} className="stack">
        <label className="f">New password<input id="pw" type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} /><span className="hint">At least 10 characters.</span></label>
        <label className="f">Confirm new password<input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {msg ? <p className="form-error" role="alert">{msg}</p> : null}
        <button className="primary big" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
      </form>
    </AuthCard>
  );
}
