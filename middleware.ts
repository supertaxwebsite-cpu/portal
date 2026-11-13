import { supabaseUrl, supabaseAnonKey } from "@/lib/supabase/env";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/setup", "/api/setup"];

export async function middleware(request: NextRequest) {
  // Design preview: plain HTML with sample data in public/preview, open without signing in.
  const p0 = request.nextUrl.pathname;
  const start: Record<string, string> = { "/preview": "index.html", "/preview/": "index.html", "/preview/staff": "home.html", "/preview/manager": "manager.html" };
  if (start[p0]) { const u = request.nextUrl.clone(); u.pathname = "/preview/" + start[p0]; return NextResponse.redirect(u); }
  if (p0.startsWith("/preview/")) return NextResponse.next();
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
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.webp|favicon-32.png|apple-touch-icon.png).*)"],
};
