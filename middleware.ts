import { supabaseUrl, supabaseAnonKey } from "@/lib/supabase/env";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { codeStepOn, cookieOk, sessionIdOf, CODE_COOKIE } from "@/lib/loginCode";

const PUBLIC = ["/login", "/setup", "/api/setup"];
/** Open after the password but before the emailed code. */
const CODE_STEP = ["/verify", "/api/login-code"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  if (!user && !PUBLIC.some((p) => path === p || path.startsWith(p + "/"))) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
    return NextResponse.redirect(url);
  }
  // Second step: the emailed sign-in code, for everyone, on every page and data route.
  if (user && codeStepOn() && !CODE_STEP.some((p) => path === p || path.startsWith(p + "/")) && !PUBLIC.some((p) => path === p || path.startsWith(p + "/"))) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!(await cookieOk(request.cookies.get(CODE_COOKIE)?.value, user.id, sessionIdOf(session?.access_token)))) {
      if (path.startsWith("/api/")) return NextResponse.json({ error: "Enter the emailed sign-in code first." }, { status: 401 });
      const url = request.nextUrl.clone();
      url.pathname = "/verify"; url.search = path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
      return NextResponse.redirect(url);
    }
  }
  // Signed-in and checked: the code page is no longer needed.
  if (user && path === "/verify" && codeStepOn()) {
    const { data: { session } } = await supabase.auth.getSession();
    if (await cookieOk(request.cookies.get(CODE_COOKIE)?.value, user.id, sessionIdOf(session?.access_token))) { const url = request.nextUrl.clone(); url.pathname = "/"; return NextResponse.redirect(url); }
  }
  // Design preview (sample data in public/preview): signed-in people only, like everything else.
  const start: Record<string, string> = { "/preview": "index.html", "/preview/": "index.html", "/preview/staff": "home.html", "/preview/manager": "manager.html" };
  if (user && start[path]) { const u = request.nextUrl.clone(); u.pathname = "/preview/" + start[path]; return NextResponse.redirect(u); }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.webp|favicon-32.png|apple-touch-icon.png).*)"],
};
