export default function AuthCard({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand"><img src="/logo.webp" alt="Supertax" width={240} height={60} /></div>
        <div className="auth-body">
          <h1>{title}</h1>
          {lead ? <p className="muted">{lead}</p> : null}
          {children}
        </div>
      </div>
      <p className="auth-foot">Supertax Practice Desk · for Supertax team members only</p>
    </main>
  );
}
