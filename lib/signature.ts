import { SIGNATURE_CID, SIGNATURE_JPG_BASE64 } from "./signatureImage";
import type { MailFile } from "./graphMail";

/** The Supertax team email signature, laid out like Team Signature.docx and added under every client email.
 *  The badges image is sent inside the email (see signatureFile) so it shows without "download pictures". */
const C = "#002451";
const F = "Calibri,Carlito,Arial,sans-serif";
const L = "#0000FF";
export function signatureHtml(): string {
  const p = (body: string, extra = "") => `<p style="margin:0;font-family:${F};font-size:12pt;line-height:1.25;color:${C};${extra}">${body}</p>`;
  const a = (href: string, text: string) => `<a href="${href}" style="color:${L};text-decoration:underline">${text}</a>`;
  const gap = p("&nbsp;");
  const t = (body: string, extra = "") => `<p style="margin:0 0 9pt;font-family:'Times New Roman',Times,serif;font-size:9pt;line-height:1.3;color:#201F1E;font-style:italic;${extra}">${body}</p>`;
  return `<div style="margin-top:18px">
${gap}
${p("Feel free to get in touch with us if you have any questions.")}
${gap}
${p("Kind Regards,")}
${p("Supertax Team", "font-weight:700")}
${gap}
${p("Tax Agent I Accountants I Certified Bookkeepers I Consultancy I Payroll I SMSF Specialist Advisor")}
${p("M: 0485 825 915")}
${p("E: info@mysupertax.com.au")}
${p("O: Suite 1, 7 Bridge St, Werribee Vic 3030")}
${p("O: (03) 7074 8818")}
${p(`W: ${a("http://www.mysupertax.com.au", "www.supertax.com.au")}`)}
${gap}
${p("&#128276; Stay connected for tax tips, reminders, and important updates:", "font-weight:700;color:#000000")}
${p(`&#128313; ${a("https://www.linkedin.com/company/supertax-pty-ltd", "Follow us on LinkedIn")}`, "padding-left:8px")}
${p(`&#128313; ${a("https://www.facebook.com/profile.php?id=100064228744878", "Like us on Facebook")}`, "padding-left:8px")}
${gap}
<p style="margin:0 0 12pt"><img src="cid:${SIGNATURE_CID}" alt="Supertax" width="545" height="255" style="display:block;width:545px;height:255px;border:0"></p>
${t("Liability limited by a scheme approved under Professional Standards Legislation.", "margin:0;font-weight:700;color:#000000")}
<p style="margin:0;font-family:'Times New Roman',Times,serif;font-size:9pt;font-weight:700;color:#FF0000">DISCLAIMER:</p>
${t("The information transmitted is intended only for the person or entity to which it is addressed and may contain confidential and/or privileged material.")}
${t("Any review, retransmission, dissemination or other use of, or taking of any action in reliance upon, this information by persons or entities other than the intended recipient is prohibited.")}
${t("If you received this in error, please contact the sender and delete the material from any computer. Supertax Pty Ltd does not warrant that this email and any attachments are error or virus free and recommends that all attachments be checked for computer viruses. This email specifically does not constitute any personal or legal advice.")}
</div>`;
}

/** The badges image as an inline attachment, referenced by the signature's cid. */
export const signatureFile = (): MailFile => ({ name: "supertax-signature.jpg", type: "image/jpeg", bytes: new Uint8Array(Buffer.from(SIGNATURE_JPG_BASE64, "base64")), cid: SIGNATURE_CID });

/** A short reference put on the subject so a client's reply finds its job again. */
export const jobRef = (jobId: string) => `PD-${jobId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
export const REF_RE = /\[PD-([0-9A-F]{8})\]/i;
