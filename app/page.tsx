import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Workspace from "@/components/Workspace";
import type { Profile } from "@/lib/types";
import AuthCard from "@/components/AuthCard";
import SignOutButton from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!me || !me.active) {
    return (
      <AuthCard title="No access" lead="Your account isn't active in Supertax Practice Desk. Speak to your master admin.">
        <SignOutButton />
      </AuthCard>
    );
  }
  if (me.must_change_password) redirect("/change-password");
  return <Workspace me={me as Profile} />;
}
