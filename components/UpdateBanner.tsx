"use client";
import { useEffect, useState } from "react";

const BUILT = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "dev";

/** Shows a "new version" bar when the portal has been updated since this page was opened. */
export default function UpdateBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (BUILT === "dev") return;
    const check = () => fetch("/api/version", { cache: "no-store" }).then((r) => r.json()).then((d: { v?: string }) => { if (d.v && d.v !== "dev" && d.v !== BUILT) setStale(true); }).catch(() => {});
    const t = setInterval(check, 5 * 60 * 1000);
    window.addEventListener("focus", check);
    check();
    return () => { clearInterval(t); window.removeEventListener("focus", check); };
  }, []);
  if (!stale) return null;
  return (
    <div className="updatebar" role="status">
      The portal has been updated. <button className="primary" onClick={() => window.location.reload()}>Refresh to get the latest</button>
    </div>
  );
}
