"use client";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await createClient().auth.signOut();
        window.location.href = "/login";
      }}
    >
      Sign out
    </button>
  );
}
