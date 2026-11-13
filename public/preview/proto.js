/* Practice Desk design preview: makes the sample screens clickable. Nothing is saved; reload resets. */
(function () {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const isMgr = /Prospects/.test(($("nav") || {}).textContent || "");
  const me = isMgr ? "Harshad" : "Naval";
  const jobPage = isMgr ? "manager-job.html" : "staff-job.html";
  const page = location.pathname.split("/").pop() || "index.html";
  const txt = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  // ---------- toast ----------
  const css = document.createElement("style");
  css.textContent = `.pt-toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%);background:#0b1a2c;color:#fff;padding:9px 16px;border-radius:10px;font:600 13.5px Manrope,system-ui,sans-serif;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;transition:opacity .3s}
  .pt-hide{display:none!important}.pt-flash{animation:ptf 1.2s}@keyframes ptf{0%{box-shadow:0 0 0 0 rgba(245,154,34,.9)}100%{box-shadow:0 0 0 14px rgba(245,154,34,0)}}
  .pt-ov{position:fixed;inset:0;background:rgba(7,18,31,.45);display:grid;place-items:center;z-index:55}.pt-md{background:#fff;color:#0b1a2c;border-radius:14px;width:min(460px,92vw);padding:18px;font:14px Manrope,system-ui,sans-serif;display:grid;gap:10px}
  .pt-md h3{margin:0;font-size:17px}.pt-md textarea,.pt-md select,.pt-md input{font:inherit;padding:8px;border:1px solid #dde6ee;border-radius:8px;width:100%;box-sizing:border-box}.pt-md textarea{min-height:90px}
  .pt-md .r{display:flex;gap:8px;justify-content:flex-end}.pt-empty td{text-align:center;color:#4b5a6d;padding:18px!important}
  .tab,.chip,.count,.tabs span,.c,.day:not(.we):not(.out),.trow{cursor:pointer}`;
  document.head.appendChild(css);
  let tt;
  function toast(m) {
    let t = $(".pt-toast"); if (!t) { t = document.createElement("div"); t.className = "pt-toast"; document.body.appendChild(t); }
    t.textContent = m; t.style.opacity = 1; clearTimeout(tt); tt = setTimeout(() => (t.style.opacity = 0), 2600);
  }
  function modal(title, fields, ok, onOk) {
    const ov = document.createElement("div"); ov.className = "pt-ov";
    ov.innerHTML = `<div class="pt-md"><h3>${title}</h3>${fields}<div class="r"><button class="btn" data-x>Cancel</button><button class="btn pri" data-ok>${ok}</button></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("[data-x]")) { ov.remove(); e.stopPropagation(); }
      if (e.target.closest("[data-ok]")) { const v = $$("textarea,input,select", ov).map((x) => x.value); ov.remove(); onOk(v); e.stopPropagation(); }
    });
    const f = $("textarea,input", ov); if (f) f.focus();
  }
  const flash = (el) => { if (!el) return; el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.remove("pt-flash"); void el.offsetWidth; el.classList.add("pt-flash"); };

  // ---------- fill one-option dropdowns ----------
  const STATUS = ["Not started", "In progress", "Waiting on client", "Query with client", "Internal query", "Ready for review", "Sent for sign", "Lodged", "Completed"];
  const TEAM = ["Naval", "Harshad", "Hardeep", "Ishwar", "Rikesh", "Jas", "Riya", "Unassigned"];
  $$("select").forEach((s) => {
    if (s.options.length > 1 || s.disabled) return;
    const v = s.value, label = txt(s.parentElement).replace(txt(s), "");
    let list = null;
    if (STATUS.includes(v)) list = STATUS;
    else if (TEAM.includes(v) || /Assign|Reviewer|manager|Staff|person/i.test(label)) list = ["Choose…", ...TEAM];
    else if (/Status/i.test(label)) list = ["Choose…", ...STATUS];
    else if (/Due/i.test(label)) list = ["Keep", "Move 1 week", "Move 2 weeks", "Pick a date"];
    else if (/^All|^Any/.test(v)) list = [v, "Supertax", "Mentor Group", "Individual", "Company", "Trust", "SMSF", "Partnership"];
    else if (/Late \(automatic\)/.test(v)) list = [v, "Working day", "Half day", "Unpaid leave", "Sick"];
    else if (v === "General") list = ["General", "Phone call", "Email", "Documents", "Reminder"];
    else if (/^Open: /.test(v)) list = [v, "Fixed, waiting for check", "Closed"];
    if (list) { s.innerHTML = list.map((o) => `<option${o === v ? " selected" : ""}>${o}</option>`).join(""); }
  });
  document.addEventListener("change", (e) => {
    const s = e.target;
    if (s.tagName === "SELECT") {
      const row = s.closest("tr,.task,li");
      const who = row ? txt($("b,.t", row) || row).slice(0, 50) : "";
      toast(`${who ? who + ": " : ""}changed to “${s.value}”`);
      const task = s.closest(".task");
      if (task && /Completed|Answered|Fixed|Done/i.test(s.value)) { task.classList.remove("now", "later"); task.classList.add("done"); }
      if (task && /Ready for review/.test(s.value)) sendToReview(task);
    }
    if (s.type === "checkbox") checkItem(s);
  });

  // ---------- checklists ----------
  function checkItem(cb) {
    const li = cb.closest("li"); if (!li) { toast(cb.checked ? "Selected" : "Unselected"); return; }
    li.classList.toggle("d", cb.checked);
    let n = $(".note", li);
    if (cb.checked) { if (!n) { n = document.createElement("span"); n.className = "note"; li.appendChild(n); } n.textContent = `${me} · just now`; }
    else if (n) n.remove();
    const ul = li.closest("ul"), all = $$("input[type=checkbox]", ul), done = all.filter((x) => x.checked).length;
    const box = ul.parentElement, head = $$(".note", box).find((x) => /Checklist/.test(x.textContent));
    if (head) head.textContent = `Checklist · ${done} of ${all.length} done`;
    const bar = $(".bar i", box); if (bar) bar.style.width = (done / all.length) * 100 + "%";
    $$(".count").forEach((c) => { if (/Checklist/.test(c.textContent)) $("i", c).textContent = `${done}/${all.length}`; });
    toast(cb.checked ? "Ticked off" : "Unticked");
  }

  // ---------- job page ----------
  function sendToReview(task) {
    task = task || $(".task.now");
    if (!task) return;
    task.classList.remove("now"); task.classList.add("done");
    const nxt = $(".task.later"); if (nxt) { nxt.classList.remove("later"); nxt.classList.add("now"); const s = $("select", nxt); if (s) { s.disabled = false; s.innerHTML = "<option>Not started</option><option>In progress</option><option>Completed</option>"; } }
    $$(".hero .pill").forEach((p) => { if (/In progress|Not started/.test(p.textContent)) { p.textContent = "Ready for review"; } });
    $$(".count").forEach((c) => { if (/Stage/.test(c.textContent)) $("i", c).textContent = "2 of 4"; });
    toast("Sent to Harshad for review. He gets a notification.");
  }
  // collapse / expand a task by clicking its row
  document.addEventListener("click", (e) => {
    const tr = e.target.closest(".trow");
    if (tr && !e.target.closest("select,button,input,a")) { const sub = tr.parentElement.querySelector(".tsub,.iqbody"); if (sub) sub.classList.toggle("pt-hide"); }
  });
  // header count chips jump to the matching task
  $$(".count").forEach((c) => c.addEventListener("click", () => {
    const k = txt(c).toLowerCase();
    const map = [["internal", ".task.iq"], ["review", ".task.rn"], ["checklist", ".check"], ["stage", ".task.now"], ["file", ".side,.links"], ["time", ".task.now .hrs"], ["client quer", ".task.now"], ["related", ".side"]];
    const m = map.find(([w]) => k.includes(w)); const t = m && $(m[1]);
    if (t) flash(t); else toast(txt(c));
  }));

  // ---------- saved-view tabs: filter the list ----------
  const FILTER = [
    [/overdue/i, /overdue/i], [/unassigned|can take/i, /unassigned|take it/i], [/review note/i, /review note/i],
    [/waiting for (my )?review|to review/i, /review/i], [/quer/i, /quer/i], [/sign/i, /sign|client quer/i],
    [/waiting on client/i, /waiting on client|sign/i], [/related/i, /🔗|related/i], [/no open jobs/i, /no open/i],
    [/new this month/i, /new/i], [/lodged/i, /lodged/i],
  ];
  const rowText = (r) => { const c = r.cloneNode(true); c.querySelectorAll("select").forEach((x, i) => { x.replaceWith(r.querySelectorAll("select")[i].value); }); return c.textContent; };
  function rowsFor(tab) {
    const host = tab.closest("section,.card,main") || document;
    let scope = tab.closest(".savedv,.tabs") ? (tab.closest(".savedv,.tabs").nextElementSibling || host) : host;
    let rows = $$("tbody tr", scope); if (!rows.length) rows = $$("tbody tr", host);
    if (!rows.length) rows = $$("tbody tr");
    return rows;
  }
  $$(".tabs span").forEach((tb) => tb.addEventListener("click", () => {
    $$(".tabs span").forEach((x) => x.classList.remove("on")); tb.classList.add("on");
    const n = txt(tb);
    if (/Month grid/.test(n)) { flash($("#grid")); toast("Month grid: everyone, every day"); }
    else if (/Leave calendar/.test(n)) { flash($("#grid")); toast("Leave calendar: only the leave squares, months ahead"); }
    else if (/Requests/.test(n)) { const h = [...document.querySelectorAll(".card h2")].find((x) => /approval/.test(x.textContent)); flash(h && h.parentElement); toast("Requests waiting for you"); }
    else if (/own timesheet/.test(n)) { toast("Opening your own timesheet"); setTimeout(() => (location.href = "ts-staff.html"), 500); }
  }));
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    const bar = tab.parentElement; $$(".tab", bar).forEach((t) => t.classList.remove("on")); tab.classList.add("on");
    const name = txt(tab).replace(/\d[\d,]*$/, "").trim();
    if (cardTabs(name)) return;
    const rows = rowsFor(tab); if (!rows.length) { toast(`Showing: ${name}`); return; }
    const f = FILTER.find(([k]) => k.test(name)), re = f && f[1];
    let shown = 0;
    rows.forEach((r) => { if (r.classList.contains("pt-empty")) return; const ok = !re || re.test(rowText(r)); r.classList.toggle("pt-hide", !ok); if (ok) shown++; });
    const tb = rows[0].parentElement; let em = $(".pt-empty", tb);
    if (!shown) { if (!em) { em = document.createElement("tr"); em.className = "pt-empty"; em.innerHTML = `<td colspan="20">Nothing here in the sample data.</td>`; tb.appendChild(em); } em.classList.remove("pt-hide"); }
    else if (em) em.classList.add("pt-hide");
    toast(`${name}: ${shown} shown`);
  }));
  // search boxes filter rows as you type
  $$("input[type=search],input[type=text],input:not([type])").forEach((i) => {
    if (i.closest(".pt-md,.task,.tsub")) return;
    i.addEventListener("input", () => { const q = i.value.toLowerCase(); $$("tbody tr").forEach((r) => r.classList.toggle("pt-hide", q && !r.textContent.toLowerCase().includes(q))); });
  });
  $$(".chip").forEach((c) => c.addEventListener("click", () => { if (c.closest(".now")) { toast(txt(c)); return; } c.classList.toggle("on"); toast(`Filter ${c.classList.contains("on") ? "on" : "off"}: ${txt(c)}`); }));

  // ---------- Timesheet ----------
  $$(".day").forEach((d) => d.addEventListener("click", () => { if (d.classList.contains("we") || d.classList.contains("out")) return; toast(`${txt(d)}`.slice(0, 90) || "No time recorded"); }));
  const pop = $(".pop");
  if (pop) {
    const names = $$("#grid tbody tr").map((r) => txt($("td.n", r)));
    $$("#grid .c").forEach((c) => c.addEventListener("click", (e) => {
      const td = c.closest("td"), tr = td.closest("tr"), col = [...tr.children].indexOf(td);
      const sec = c.closest("section").getBoundingClientRect(), r = c.getBoundingClientRect();
      $$("#grid .c.sel").forEach((x) => x.classList.remove("sel")); c.classList.add("sel");
      const kind = { P: "Present", L: "Late", H: "Half day", S: "Leave", A: "Absent", B: "Booked leave", Q: "Leave waiting", N: "Forgot to log out", W: "Working" }[[...c.classList].find((k) => k.length === 1 && k !== "c")] || "";
      $("h4", pop).textContent = `${txt($("td.n b", tr))} · ${col} Nov · ${kind}`;
      pop.style.left = Math.min(r.left - sec.left + 24, sec.width - 290) + "px"; pop.style.top = r.top - sec.top + 24 + "px"; pop.classList.remove("pt-hide");
      e.stopPropagation();
    }));
    document.addEventListener("click", (e) => { if (!e.target.closest(".pop") && !e.target.closest("#grid .c")) pop.classList.add("pt-hide"); });
  }

  // ---------- buttons ----------
  let breakOn = false;
  const removeRow = (b, msg) => { const li = b.closest("li,tr"); if (li) { li.style.transition = "opacity .3s"; li.style.opacity = 0; setTimeout(() => li.remove(), 300); } toast(msg); };
  const timers = new WeakMap();
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button,.btn,.crumb a"); if (!b || b.closest(".pt-md,.protobar")) return;
    const t = txt(b).replace(/IDEA \d/, "").trim(), row = b.closest("li,tr,.task");
    const rowName = row ? txt($("b,.t,.tname", row) || row).slice(0, 40) : "";
    if (/^← Jobs$/.test(t)) { location.href = isMgr ? "jobs.html" : "staff-jobs.html"; return; }
    if (/^← Clients$/.test(t)) { location.href = isMgr ? "clients.html" : "clients-s.html"; return; }
    if (t === "Sign out") { toast("Signed out"); setTimeout(() => (location.href = "index.html"), 500); return; }
    if (/Email client/.test(t)) { modal("Email the client", `<input value="To: client@example.com.au"><input value="Subject: Documents needed for your BAS"><textarea>Hi, could you please send the fuel tax invoices for the quarter? Thanks.</textarea>`, "Send email", () => toast("Email sent. A copy is saved on the job.")); return; }
    if (/Files|All files/.test(t)) { modal("Files", `<div>📎 query-sheet.xlsx · Naval · 12 Nov<br>📎 client-query-list.xlsx · Harshad · 12 Nov<br>📎 bank-statements-Q4.pdf · client · 2 Nov</div><input type="file">`, "Upload", () => toast("File uploaded")); return; }
    if (/Related clients/.test(t)) { location.href = isMgr ? "client.html" : "client-s.html"; return; }
    if (/Link a client/.test(t)) { modal("Link a related client", `<input placeholder="Search clients"><select><option>Director of</option><option>Trustee of</option><option>Spouse</option><option>Same family group</option></select>`, "Link", () => toast("Clients linked")); return; }
    if (/Finish the group/.test(t)) { toast("Opens all the group's open jobs together, so they can be finished in one go"); return; }
    if (/Import from CSV/.test(t)) { modal("Import clients", `<div>Use the template so the columns match.</div><input type="file" accept=".csv,.xlsx">`, "Import", () => toast("Clients imported")); return; }
    if (/Columns/.test(t)) { modal("Show columns", `<label><input type="checkbox" checked style="width:auto"> Entity</label><label><input type="checkbox" checked style="width:auto"> Manager</label><label><input type="checkbox" style="width:auto"> ABN</label><label><input type="checkbox" style="width:auto"> Phone</label>`, "Apply", () => toast("Columns updated")); return; }
    if (/Create jobs for a period/.test(t)) { modal("Create jobs for a period", `<select><option>BAS</option><option>Payroll</option><option>Tax return</option></select><select><option>Q2 FY27 (Oct to Dec)</option><option>Q3 FY27 (Jan to Mar)</option></select><div>Creates one job for every client with this service.</div>`, "Create jobs", (v) => toast(`${v[0]} jobs created for ${v[1]}`)); return; }
    if (t === "Open day") { toast("Opens that person's day: log-ins and job times"); return; }
    if (/^(Open|View tasks|Start review|Answer)$/.test(t)) { location.href = /^clients/.test(page) ? (isMgr ? "client.html" : "client-s.html") : jobPage; return; }
    if (t === "Start") { b.textContent = "Stop"; b.classList.add("pri"); let s = 0; timers.set(b, setInterval(() => { s++; b.title = s + "s"; }, 1000)); toast(`Timer started on ${rowName}`); return; }
    if (t === "Stop") { b.textContent = "Start"; b.classList.remove("pri"); clearInterval(timers.get(b)); toast(`Timer stopped. Time saved to ${rowName}`); return; }
    if (t === "Take it") { const td = b.closest("td"); if (td) td.textContent = me; else { b.textContent = "Taken"; b.disabled = true; } toast("The job is now yours"); return; }
    if (/^Approve( late)?$/.test(t)) { if (b.closest(".pop")) { toast("Late start approved"); pop.classList.add("pt-hide"); return; } removeRow(b, `Approved: ${rowName}. They get a notification.`); return; }
    if (t === "Reject") { if (b.closest(".pop")) { toast("Late start rejected"); pop.classList.add("pt-hide"); return; } removeRow(b, `Rejected: ${rowName}`); return; }
    if (t === "Still waiting") { removeRow(b, "Reminder hidden for 2 days"); return; }
    if (t === "Cancel" && row) { removeRow(b, "Leave request cancelled"); return; }
    if ((t === "Cancel" || t === "Close") && !b.hasAttribute("data-close")) { location.href = "review.html"; return; }
    if (t === "Add review note" && b.closest(".overlay,.modal")) { location.href = "review.html"; toast("Review note added"); return; }
    if (/Add review note/.test(t)) { location.href = "review-add.html"; return; }
    if (/Send to Review/.test(t)) { sendToReview(b.closest(".task")); return; }
    if (/Approve → Client signature/.test(t)) { $$(".hero .pill").forEach((p) => (p.textContent = "Sent for sign")); toast("Approved. The job moves to Client signature."); b.disabled = true; return; }
    if (/Send back/.test(t)) { $$(".hero .pill").forEach((p) => (p.textContent = "In progress")); toast("Sent back to Naval with your review notes"); return; }
    if (/Raise internal query/.test(t)) {
      modal("Raise internal query", `<select><option>Harshad</option><option>Hardeep</option></select><textarea placeholder="What's the query?"></textarea><input type="file">`, "Send query", (v) => toast(`Query sent to ${v[0]}. They get a notification.`)); return;
    }
    if (/Apply for leave/.test(t)) { const f = [...document.querySelectorAll(".card h2")].find((h) => /Apply for leave/.test(h.textContent)); flash(f && f.parentElement); toast("Fill in the form on the right"); return; }
    if (/Send to manager for approval/.test(t)) {
      const ul = [...document.querySelectorAll(".card h2")].find((h) => /My requests/.test(h.textContent)); const list = ul && ul.parentElement.querySelector("ul");
      if (list) { const li = document.createElement("li"); li.innerHTML = `<span>🌴</span><div><b>21–24 Dec</b> · Unpaid leave, 4 days<div class="s">Sent just now</div></div><span class="acts"><span class="pill p-warn">Waiting</span><button class="btn sm">Cancel</button></span>`; list.prepend(li); flash(li); }
      toast("Leave request sent to Harshad"); return;
    }
    if (/Start break/.test(t) || /End break/.test(t)) { breakOn = !breakOn; b.innerHTML = breakOn ? "▶ End break" : "☕ Start break"; toast(breakOn ? "On break. The idle pop-up won't show." : "Back from break"); return; }
    if (/Log out for the day/.test(t)) { modal("Log out early?", `<div>You've worked <b>5h 12m</b> today. Your suggested log-out time is <b>4:38 pm</b>, so you're 3h 03m short of 8h 15m.</div><textarea placeholder="Reason for leaving early (goes to your manager)"></textarea>`, "Log out anyway", () => { toast("Logged out. Your manager sees the reason."); b.disabled = true; }); return; }
    if (t === "‹" || t === "›") { toast("The sample data only has November 2026"); return; }
    if (/Mark sick/.test(t)) { const c = b.closest(".chip"); if (c) { c.className = "chip off"; b.remove(); $(".s", c).textContent = "sick leave today"; } toast("Marked as sick leave for today"); return; }
    if (/\+ Add leave for someone/.test(t)) { modal("Add leave for someone", `<select>${TEAM.slice(0, 7).map((n) => `<option>${n}</option>`).join("")}</select><select><option>Unpaid leave</option><option>Sick</option><option>Personal</option></select><input placeholder="Dates, e.g. 1–3 Dec">`, "Add leave", (v) => toast(`${v[1]} added for ${v[0]}`)); return; }
    if (/Export|Download/.test(t)) { toast("In the real portal this downloads a spreadsheet"); return; }
    if (/Add note|Add confidential note/.test(t)) { const ta = b.closest("section,.card") && $("textarea", b.closest("section,.card")); modal(t.replace("+ ", ""), `<textarea placeholder="Type the note">${ta ? ta.value : ""}</textarea>`, "Save note", () => toast("Note saved")); return; }
    if (/New job/.test(t)) { modal("New job", `<select><option>BAS</option><option>Tax return</option><option>SMSF</option><option>Payroll</option></select><select>${TEAM.map((n) => `<option>${n}</option>`).join("")}</select><input placeholder="Period, e.g. Q2 FY27">`, "Create job", (v) => toast(`${v[0]} job created and assigned to ${v[1]}`)); return; }
    if (/Add client/.test(t)) { modal("Add client", `<input placeholder="Client name"><select><option>Individual</option><option>Company</option><option>Trust</option><option>SMSF</option></select>`, "Add client", (v) => toast(`${v[0] || "Client"} added`)); return; }
    if (/Apply to \d+ jobs/.test(t)) { toast("Changes applied to the selected jobs"); return; }
    if (t === "Clear") { $$(".pt-hide").forEach((x) => x.classList.remove("pt-hide")); $$(".chip.on").forEach((c) => c.classList.remove("on")); $$("input[type=search],input[type=text]").forEach((i) => (i.value = "")); toast("Filters cleared"); return; }
    if (/Edit job|Edit client/.test(t)) { toast(isMgr ? "Opens the edit form (managers and masters only)" : "Only managers can edit this"); return; }
    if (/Explain/.test(t)) { modal("Explain this day", `<textarea placeholder="e.g. Left early for a doctor's appointment"></textarea>`, "Send to manager", () => toast("Sent to your manager")); return; }
    if (/^Processed, send for sign-off$|^Confirm super paid$|^STP lodged, finish$/.test(t)) { payAdvance(b); return; }
    if (t === "Undo") { toast("Super sign-off undone. Back to Processing."); return; }
    if (t === "Edit" && b.closest(".mc")) { openDrawer(b.closest(".mc").dataset.name); return; }
    if (b.hasAttribute("data-close")) { $("#drawer").classList.remove("open"); return; }
    if (t === "Save changes") { $("#drawer").classList.remove("open"); toast("Saved. The new access applies next time they open the portal."); return; }
    if (/Turn off this login/.test(t)) { modal("Turn off this login?", `<div>They can't sign in any more. Their jobs and history stay.</div>`, "Turn off", () => { $("#drawer").classList.remove("open"); toast("Login turned off"); }); return; }
    if (t === "View jobs") { location.href = "jobs.html"; return; }
    if (t === "Reset password") { toast("A new temporary password is shown once for you to pass on"); return; }
    if (/Add team member/.test(t)) { openDrawer("new team member"); return; }
    if (/What each role can do/.test(t)) { flash($(".matrix")); toast("What each role can do"); return; }
    if (/Add prospect/.test(t)) { modal("Add prospect", `<input placeholder="Name"><input placeholder="Contact person"><select><option>Referral from a client</option><option>Website</option><option>Google</option><option>Social media</option><option>Walk-in or phone call</option></select><input placeholder="Fee quoted per year, e.g. 3500">`, "Add prospect", (v) => addProspect(v)); return; }
    if (t === "Read it") { const o = $("#qbout"); o.classList.remove("pt-hide"); flash(o); toast("Read it. Check the details, then Book it."); return; }
    if (t === "Book it") { const d = $('.md[data-day="17"]'); if (d) { const e = document.createElement("span"); e.className = "ev t"; e.textContent = "10:30 Teams · Deepa Shah"; d.appendChild(e); flash(d); } toast("Meeting booked. Invites sent and a reminder set."); return; }
    if (t === "Change details" || (t === "Change" && b.closest(".list"))) { modal("Change meeting", `<input value="${t === "Change" ? rowName : "Call with Deepa Shah"}"><input type="datetime-local"><select><option>In the office</option><option>Microsoft Teams</option><option>Phone</option></select>`, "Save", () => toast("Meeting updated")); return; }
    if (t === "Join") { toast("Opens the Teams call in a new tab"); return; }
    if (/Book a meeting/.test(t)) { bookDay(""); return; }
    if (t === "Today" && $(".mcal")) { flash($(".md.now")); toast("Today: 2 meetings"); return; }
    if (/desktop alerts/.test(t)) { toast("Desktop alerts on. You'll get a pop-up 10 minutes before each meeting."); return; }
    if (/New payroll client/.test(t)) { modal("New payroll client", `<input placeholder="Client"><select><option>Weekly</option><option>Fortnightly</option><option>Monthly</option></select><input type="date"><select>${TEAM.map((n) => `<option>${n}</option>`).join("")}</select>`, "Create", (v) => toast(`${v[1]} payroll set up. A job is created on each pay day.`)); return; }
    toast(`In the real portal: ${t}`);
  });

  // ---------- tabs that filter cards (Team, Prospects) ----------
  function cardTabs(name) {
    const mcs = $$(".mc"), pcs = $$(".pc");
    if (!mcs.length && !pcs.length) return false;
    let test = () => true;
    if (mcs.length) {
      const m = name.match(/^(\w+)'s team/);
      if (m) test = (c) => c.textContent.includes("Team leader " + m[1]) || c.dataset.name === m[1];
      else if (/Working now/.test(name)) test = (c) => !!$(".st.in", c);
      else if (/On leave/.test(name)) test = (c) => !!$(".st.off", c);
      mcs.forEach((c) => c.classList.toggle("pt-hide", !test(c)));
      toast(`${name}: ${mcs.filter((c) => !c.classList.contains("pt-hide")).length} shown`); return true;
    }
    if (/Follow-up due/.test(name)) test = (c) => !!$(".fu.due", c);
    else if (/Mine/.test(name)) test = (c) => /HK/.test(txt($(".av", c)));
    if (/List/.test(name)) toast("List view: the same prospects as a table you can sort");
    else toast(`${name}: ${pcs.filter((c) => test(c)).length} shown`);
    pcs.forEach((c) => c.classList.toggle("pt-hide", !test(c)));
    return true;
  }
  // ---------- prospects board: drag and drop, or click a card to move it on ----------
  let dragEl = null;
  function wireCard(c) {
    c.addEventListener("dragstart", () => { dragEl = c; c.classList.add("dragging"); });
    c.addEventListener("dragend", () => { c.classList.remove("dragging"); });
    c.addEventListener("click", () => { const col = c.closest(".col"); const next = col && col.nextElementSibling; if (next && next.classList.contains("col") && !/Won|Lost/.test(txt($("h3", col)))) moveCard(c, next); });
  }
  function colSums() { $$(".col").forEach((col) => { const cs = $$(".pc", col); const tot = cs.reduce((a, c) => a + Number((txt($(".fee", c)).match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")), 0); const sp = $("h3 span", col); if (sp) sp.textContent = `${cs.length} · $${tot.toLocaleString()}`; }); }
  function moveCard(c, col) {
    col.insertBefore(c, $(".pc", col)); colSums(); flash(c);
    const stage = txt($("h3", col)).replace(/\s\d.*$/, "");
    toast(/Won/.test(stage) ? `${txt($("b", c))} won! Convert to client creates the client and their jobs.` : `${txt($("b", c))} moved to ${stage}`);
  }
  $$(".pc").forEach(wireCard);
  $$(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("over"); if (dragEl) moveCard(dragEl, col); });
  });
  function addProspect(v) {
    const col = $(".col"); if (!col) return;
    const c = document.createElement("div"); c.className = "pc"; c.draggable = true;
    c.innerHTML = `<b>${v[0] || "New prospect"}</b><span class="small">${v[1] || "No contact yet"} · ${v[2]}</span><div style="display:flex;justify-content:space-between;align-items:center"><span class="fee">$${Number(v[3] || 0).toLocaleString()}<span class="small"> /yr</span></span><span class="av">HK</span></div><span class="fu due">⏰ Follow up today</span>`;
    col.insertBefore(c, $(".pc", col)); wireCard(c); colSums(); flash(c); toast("Prospect added");
  }
  // ---------- team: edit drawer, switches, client-type chips ----------
  function openDrawer(name) { const d = $("#drawer"); if (!d) return; $("#dname").textContent = /new/.test(name) ? "Add team member" : `Edit ${name}`; d.classList.add("open"); }
  document.addEventListener("click", (e) => {
    const sw = e.target.closest(".tog"); if (sw) { sw.classList.toggle("on"); const lab = sw.parentElement.querySelector("span"); toast(`${lab ? lab.firstChild.textContent.trim() : "Setting"}: ${sw.classList.contains("on") ? "on" : "off"}`); return; }
    const ch = e.target.closest(".chips span"); if (ch) { ch.classList.toggle("on"); toast(`${txt(ch)} clients ${ch.classList.contains("on") ? "allowed" : "hidden"}`); }
  });
  // ---------- payroll: move a pay run along ----------
  function payAdvance(b) {
    const tr = b.closest("tr"), steps = $$(".steps3 i", tr), cur = steps.findIndex((i) => i.classList.contains("n"));
    const NAMES = ["Processing", "Super to confirm", "STP to lodge", "Finished"], k = cur + 1;
    steps.forEach((i, x) => { i.className = x < k ? "d" : x === k ? "n" : ""; });
    $(".steps3 + .small", tr).textContent = NAMES[k];
    const pill = $(".pill", tr); pill.textContent = NAMES[k]; pill.className = "pill " + (k === 3 ? "p-ok" : "p-warn");
    const cell = b.closest("td");
    if (k === 1) cell.innerHTML = isMgr ? '<button class="btn sm pri">Confirm super paid</button>' : '<span class="small">Waiting for super sign-off</span>';
    if (k === 2) cell.innerHTML = '<button class="btn sm pri">STP lodged, finish</button>';
    if (k === 3) cell.innerHTML = '<span class="pill p-ok">Finished</span>';
    toast(["", isMgr ? "Processed. Super sign-off is next." : "Sent to your manager to confirm super", "Super confirmed. Lodge STP next.", "Finished. The next pay day is already set up."][k]);
  }
  // ---------- meetings ----------
  function bookDay(d) {
    modal(`Book a meeting${d ? " on " + d + " Nov" : ""}`, `<input placeholder="Title, e.g. BAS review with ABC Pty Ltd"><input placeholder="Client"><input type="time" value="10:00"><select><option>30 min</option><option>45 min</option><option>1 hour</option></select><select><option>In the office</option><option>Microsoft Teams</option><option>Phone</option></select>`, "Book it", (v) => {
      const cell = $(`.md[data-day="${d || 17}"]`); if (cell) { const e = document.createElement("span"); e.className = "ev " + (/Teams/.test(v[4]) ? "t" : "o"); e.textContent = `${v[2]} ${v[0] || "Meeting"}`; cell.appendChild(e); flash(cell); }
      toast("Meeting booked. A reminder pops up 10 minutes before.");
    });
  }
  $$(".md").forEach((m) => m.addEventListener("click", (e) => { if (e.target.closest(".ev")) { toast(txt(e.target)); return; } if (!m.classList.contains("out")) bookDay(m.dataset.day); }));
  const qo = $("#qbout"), qi = $("#qbin"); if (qo && qi) qi.addEventListener("input", () => qo.classList.add("pt-hide"));

  // manager page: "All jobs by status" numbers and attention items go to the jobs list
  if (page === "manager.html") $$(".mono").forEach((m) => { if (/^\d+$/.test(txt(m))) { m.style.cursor = "pointer"; m.addEventListener("click", () => (location.href = "jobs.html")); } });
})();
