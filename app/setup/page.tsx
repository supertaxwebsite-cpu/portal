"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/AuthCard";
import { createClient } from "@/lib/supabase/client";

export default function SetupPage() {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "open" | "done" | "error">("checking");
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ fullName: "", email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/setup").then((r) => r.json()).then((d) => {
      if (d.error) { setState("error"); setMsg(d.error); } else setState(d.needsSetup ? "open" : "done");
    }).catch(() => { setState("error"); setMsg("The server did not answer."); });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) { setMsg("The two passwords don't match."); return; }
    setBusy(true); setMsg("");
    const r = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.error ?? "Setup failed."); setBusy(false); return; }
    const supabase = createClient();
    await supabase.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
    router.replace("/");
    router.refresh();
  }

  if (state === "checking") return <AuthCard title="Checking setup…">{null}</AuthCard>;
  if (state === "error") return <AuthCard title="Setup can't run yet" lead={`The database isn't ready: ${msg}. Check the Supabase keys and that schema.sql has been run.`}>{null}</AuthCard>;
  if (state === "done") return <AuthCard title="Setup is already done" lead="The master admin account exists."><a className="btn primary big" href="/login">Go to sign in</a></AuthCard>;

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthCard title="Create the master admin" lead="This is a one-time step. The account you create here controls who else can sign in.">
      <form onSubmit={submit} className="stack">
        <label className="f">Your name<input id="fullName" required value={f.fullName} onChange={set("fullName")} /></label>
        <label className="f">Email<input id="email" type="email" autoComplete="username" required value={f.email} onChange={set("email")} /></label>
        <label className="f">Password<input id="password" type="password" autoComplete="new-password" minLength={10} required value={f.password} onChange={set("password")} /><span className="hint">At least 10 characters.</span></label>
        <label className="f">Confirm password<input id="confirm" type="password" autoComplete="new-password" required value={f.confirm} onChange={set("confirm")} /></label>
        {msg ? <p className="form-error" role="alert">{msg}</p> : null}
        <button className="primary big" disabled={busy}>{busy ? "Creating…" : "Create master admin"}</button>
      </form>
    </AuthCard>
  );
}
