/** Tidies a client's email reply for showing in the portal: drops inline-image placeholders ([cid:…]),
 *  turns "site<http://site>" links into plain text, and splits the client's own signature and
 *  disclaimer off so they can sit behind "Show signature". */
const SIGNOFF = /^\s*(thanks|thank you|many thanks|thanks (&|and) regards|kind regards|warm regards|best regards|regards|best wishes|best|cheers|sincerely|yours sincerely|yours faithfully)\b[\s,.!]*$/i;
const DISCLAIMER = /^\s*(liability limited|disclaimer|confidentiality|this e-?mail (and any|is|may)|the information (in|contained|transmitted)|important:|notice:)/i;

export function tidyMail(body: string): string {
  return (body || "")
    .replace(/\r/g, "")
    .replace(/\[cid:[^\]]*\]/gi, "")
    .replace(/([^\s<>]+)\s*<(?:https?:\/\/|mailto:)[^>\s]*>/gi, "$1")
    .replace(/<(?:https?:\/\/|mailto:)([^>\s]*)>/gi, "$1")
    .replace(/^\s*[_=-]{8,}\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitMail(body: string): { main: string; sig: string } {
  const lines = tidyMail(body).split("\n");
  let cut = -1;
  // The last sign-off line (not the very first line, e.g. a reply that opens with "Thank you,"), plus the name under it.
  for (let i = lines.length - 1; i > 0; i--) if (SIGNOFF.test(lines[i])) { cut = i; break; }
  if (cut > 0) {
    let k = cut + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k < lines.length && lines[k].trim().length <= 40) cut = k; // the sender's name
  } else {
    const d = lines.findIndex((l, i) => i > 0 && DISCLAIMER.test(l));
    if (d > 0) cut = d - 1;
  }
  if (cut < 0 || cut >= lines.length - 1) return { main: lines.join("\n"), sig: "" };
  return { main: lines.slice(0, cut + 1).join("\n").trim(), sig: lines.slice(cut + 1).join("\n").replace(/^\n+/, "").trim() };
}
