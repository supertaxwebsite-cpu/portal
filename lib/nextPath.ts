/** Where to go after signing in: only a page on this site. */
export function safeNext(): string {
  const n = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("next") ?? "";
  return /^\/(?![\/\\])/.test(n) ? n : "";
}
