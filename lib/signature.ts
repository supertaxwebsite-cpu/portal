/** The Supertax team email signature, added under every email the portal sends. */
const C = "#002451";
export function signatureHtml(origin: string): string {
  const a = (href: string, text: string) => `<a href="${href}" style="color:${C};text-decoration:underline">${text}</a>`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;line-height:1.45;color:${C};margin-top:18px">
<p style="margin:0 0 10px">Feel free to get in touch with us if you have any questions.</p>
<p style="margin:0">Kind Regards,</p>
<p style="margin:0 0 10px;font-weight:700">Supertax Team</p>
<img src="${origin}/email-signature.jpg" alt="Supertax: IPA, Tax Practitioners Board registered tax agent 26183620, NTAA, The Tax Institute, Institute of Certified Bookkeepers, SMSF Association, ASIC registered agent, Xero, QuickBooks, MYOB, BGL, Class, Sage" width="545" style="display:block;width:545px;max-width:100%;height:auto;margin:0 0 10px;border:0">
<p style="margin:0 0 6px;font-weight:700">Tax Agent I Accountants I Certified Bookkeepers I Consultancy I Payroll I SMSF Specialist Advisor</p>
<p style="margin:0">M: 0485 825 915</p>
<p style="margin:0">E: ${a("mailto:info@mysupertax.com.au", "info@mysupertax.com.au")}</p>
<p style="margin:0">O: Suite 1, 7 Bridge St, Werribee Vic 3030</p>
<p style="margin:0">O: (03) 7074 8818</p>
<p style="margin:0 0 10px">W: ${a("http://www.mysupertax.com.au", "www.supertax.com.au")}</p>
<p style="margin:0 0 10px">🔔 Stay connected for tax tips, reminders, and important updates: 🔹 ${a("https://www.linkedin.com/company/supertax-pty-ltd", "Follow us on LinkedIn")} 🔹 ${a("https://www.facebook.com/profile.php?id=100064228744878", "Like us on Facebook")}</p>
<p style="margin:0 0 6px;font-size:11px">Liability limited by a scheme approved under Professional Standards Legislation.</p>
<p style="margin:0;font-size:11px;color:#555"><b>DISCLAIMER:</b> The information transmitted is intended only for the person or entity to which it is addressed and may contain confidential and/or privileged material. Any review, retransmission, dissemination or other use of, or taking of any action in reliance upon, this information by persons or entities other than the intended recipient is prohibited. If you received this in error, please contact the sender and delete the material from any computer. Supertax Pty Ltd does not warrant that this email and any attachments are error or virus free and recommends that all attachments be checked for computer viruses. This email specifically does not constitute any personal or legal advice.</p>
</div>`;
}

/** A short reference put on the subject so a client's reply finds its job again. */
export const jobRef = (jobId: string) => `PD-${jobId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
export const REF_RE = /\[PD-([0-9A-F]{8})\]/i;
