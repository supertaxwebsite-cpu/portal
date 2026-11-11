"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";

type SB = ReturnType<typeof createClient>;
export interface JobFile { id: string; job_id: string; path: string; name: string; size: number; mime: string; kind: string; uploaded_by: string | null; created_at: string }

export const FILE_KINDS = [
  { id: "query_sheet", label: "Query sheet" },
  { id: "document", label: "Client document" },
  { id: "workpaper", label: "Workpaper" },
  { id: "other", label: "Other" },
];
const kindLabel = (k: string) => FILE_KINDS.find((x) => x.id === k)?.label ?? k;
const MAX = 25 * 1024 * 1024;
const ACCEPT = ".pdf,.xlsx,.xls,.xlsm,.csv,.docx,.doc,.txt,.png,.jpg,.jpeg,.heic,.msg,.eml,.zip";
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (s: string) => new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
// Storage keys must be plain: keep letters, numbers, dot, dash and underscore.
const safe = (name: string) => name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-120) || "file";

/** Files attached to one job: query sheets, client documents, workpapers. */
export default function JobFiles({ jobId, meId, canDelete, readOnly, supabase, personName, say, onCount }: {
  jobId: string; meId: string; canDelete: boolean; readOnly?: boolean; supabase: SB;
  personName: (id: string | null) => string; say: (m: string, err?: boolean) => void; onCount?: (n: number) => void;
}) {
  const [files, setFiles] = useState<JobFile[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [kind, setKind] = useState("query_sheet");
  const [busy, setBusy] = useState("");
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("job_files").select("*").eq("job_id", jobId).order("created_at", { ascending: false });
    if (error) { setMissing(true); setFiles([]); onCount?.(0); return; }
    setFiles(data as JobFile[]); onCount?.((data as JobFile[]).length);
  }, [supabase, jobId, onCount]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`job-files-${jobId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_files", filter: `job_id=eq.${jobId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, jobId, load]);

  async function upload(list: FileList | File[]) {
    const all = Array.from(list);
    if (!all.length) return;
    const tooBig = all.filter((f) => f.size > MAX);
    if (tooBig.length) say(`${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 25 MB and wasn't uploaded`, true);
    let done = 0;
    for (const f of all.filter((x) => x.size <= MAX)) {
      setBusy(`Uploading ${f.name}…`);
      const path = `${jobId}/${crypto.randomUUID()}-${safe(f.name)}`;
      const up = await supabase.storage.from("job-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
      if (up.error) { say(`${f.name} wasn't uploaded: ${up.error.message}`, true); continue; }
      const { error } = await supabase.from("job_files").insert({ job_id: jobId, path, name: f.name.slice(0, 255), size: f.size, mime: f.type, kind, uploaded_by: meId });
      if (error) { await supabase.storage.from("job-files").remove([path]); say(`${f.name} wasn't saved: ${error.message}`, true); continue; }
      done++;
    }
    setBusy("");
    if (input.current) input.current.value = "";
    if (done) say(`${done} file${done === 1 ? "" : "s"} attached`);
    load();
  }
  async function open(f: JobFile, download: boolean) {
    const { data, error } = await supabase.storage.from("job-files").createSignedUrl(f.path, 120, download ? { download: f.name } : undefined);
    if (error || !data) { say(`Couldn't open ${f.name}: ${error?.message ?? "unknown error"}`, true); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }
  async function remove(f: JobFile) {
    if (!window.confirm(`Delete ${f.name} from this job? This can't be undone.`)) return;
    setBusy(`Deleting ${f.name}…`);
    const { error } = await supabase.from("job_files").delete().eq("id", f.id);
    if (!error) await supabase.storage.from("job-files").remove([f.path]);
    setBusy("");
    if (error) { say(`Not deleted: ${error.message}`, true); return; }
    say("File deleted"); load();
  }

  if (missing) return <div className="jobfiles"><p className="note">Run the database update for job files in Supabase to switch on attachments.</p></div>;
  return (
    <div className="jobfiles">
      {!readOnly ? <div className={`dropzone${drag ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) upload(e.dataTransfer.files); }}>
        <label className="f" style={{ minWidth: 170 }}>Type<select id="jf-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{FILE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
        <div style={{ flex: 1, minWidth: 200 }}>
          <input ref={input} id="jf-file" type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && upload(e.target.files)} />
          <button type="button" className="primary" disabled={!!busy} onClick={() => input.current?.click()}>Attach files</button>
          <span className="note" style={{ marginLeft: 10 }}>{busy || "or drag them here. PDF, Excel, Word, images or email, up to 25 MB each."}</span>
        </div>
      </div> : null}
      {!files ? <div className="empty">Loading…</div> : !files.length ? <div className="empty"><strong>No files yet.</strong>Attach the query sheet, documents from the client or your workpapers here so everyone on the job has them.</div> : (
        <ul className="filelist">{files.map((f) => (
          <li key={f.id}>
            <span className={`tag${f.kind === "query_sheet" ? " qs" : ""}`}>{kindLabel(f.kind)}</span>
            <button type="button" className="link fname" title={f.name} onClick={() => open(f, false)}>{f.name}</button>
            <span className="note">{size(f.size)} · {personName(f.uploaded_by) || "someone"} · {when(f.created_at)}</span>
            <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
              <button type="button" onClick={() => open(f, true)}>Download</button>
              {!readOnly && (f.uploaded_by === meId || canDelete) ? <button type="button" className="danger" onClick={() => remove(f)} aria-label={`Delete ${f.name}`}>Delete</button> : null}
            </span>
          </li>))}</ul>)}
      <p className="note" style={{ margin: "10px 0 0" }}>Files are private to your team. Please don&apos;t upload documents that show full TFNs, passwords or bank account details.</p>
    </div>
  );
}
