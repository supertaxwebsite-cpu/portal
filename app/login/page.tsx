"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/AuthCard";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/setup").then((r) => r.json()).then((d) => { if (d.needsSetup) router.replace("/setup"); }).catch(() => {});
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setError(/banned/i.test(error.message) ? "Your access has been switched off. Speak to your master admin." : "That email and password don't match. Check them and try again.");
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <AuthCard title="Sign in" lead="Use the email and password your master admin gave you.">
      <form onSubmit={submit} className="stack">
        <label className="f">Email<input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="f">Password<input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary big" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="note">Forgot your password? Ask your master admin to reset it.</p>
      </form>
    </AuthCard>
  );
}
