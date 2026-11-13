/** Standard steps for each type of job. Ticks are saved per job (job_checks). */
const BAS = ["Bank accounts reconciled to statements", "Sales and income checked", "Purchases and GST coding checked", "Payroll / PAYG withholding (W1, W2) agrees to STP", "Fuel tax credits, capital purchases and adjustments checked", "Compared with last period, variances explained", "BAS figures checked by preparer"];
const RETURN = ["Prior year return and notes reviewed", "ATO pre-fill report downloaded", "Income: salary, interest, dividends, rental and other income", "Deductions and receipts checked", "Private health, HELP/HECS and Medicare checked", "Prior year carried forward losses and balances checked", "Workpapers saved in Files"];
const ENTITY = ["Prior year financials and return reviewed", "Bank and loan accounts reconciled", "Trial balance reviewed, coding checked", "GST and BAS figures agree to the ledger", "Payroll, super and PAYG agree to STP", "Div 7A / loans and related party balances checked", "Depreciation and assets register updated", "Tax reconciliation and return prepared", "Workpapers saved in Files"];
export const CHECKLISTS: Record<string, string[]> = {
  bas: BAS,
  ias: ["PAYG instalment amount or rate checked", "PAYG withholding agrees to STP", "Compared with last period"],
  payroll: ["Timesheets and pay changes received", "Pay run processed and checked", "Super calculated", "STP lodged", "Payslips sent"],
  bookkeeping: ["Bank feeds up to date", "Transactions coded", "Receipts and invoices matched", "Bank reconciled", "Queries listed for the client"],
  itr: RETURN,
  ctr: ENTITY,
  trust: [...ENTITY.slice(0, -2), "Trust distribution resolution checked", "Beneficiary distributions calculated", "Tax reconciliation and return prepared", "Workpapers saved in Files"],
  partnership: [...ENTITY.slice(0, -2), "Partner distributions calculated", "Tax reconciliation and return prepared", "Workpapers saved in Files"],
  smsf: ["Bank and investment statements received", "Contributions checked against caps", "Pensions and minimum payments checked", "Investment income and market values updated", "Financial statements prepared", "Member statements prepared", "Sent to the auditor", "Audit queries answered"],
  fin: ["Trial balance reviewed", "Balance sheet accounts reconciled", "Profit and loss reviewed against last year", "Notes and statements prepared"],
  fbt: ["Cars and logbooks", "Entertainment and meals", "Loans and other benefits", "Employee contributions", "FBT calculation checked"],
  tpar: ["Contractor payments listed", "ABNs and details checked", "Totals agree to the ledger"],
  ato_payment: ["Amount and due date taken from the ATO account", "Payment reference (PRN) and BPAY / card details sent to the client", "Payment plan set up if they can't pay in full", "Client confirms it's paid", "Payment shows on the ATO account"],
  sgc: ["Employees and quarters with late or missed super listed", "Shortfall, interest and admin fee worked out", "SGC statement lodged by the due date", "Client told the amount and how to pay", "Late payment offset recorded (if any)"],
  ato_comm: ["Letter saved to Files and deadline noted", "Reply, objection or extension request prepared", "Penalty or interest remission asked for (if it fits)", "Copy sent to the client", "Followed up until the ATO confirms"],
  company_formation: [] as string[],
  asic: ["Company statement reviewed", "Details updated with ASIC", "Annual fee paid or invoiced", "Solvency resolution signed"],
};
/** Jobs done in steps: each step has its own checklist. */
export const STEPS: Record<string, { title: string; items: string[] }[]> = {
  company_formation: [
    { title: "Directors and shareholders", items: ["Directors' full names, addresses, dates and places of birth", "Director ID for every director", "Shareholders and how many shares each", "Signed consents to act as director"] },
    { title: "Company name, office and rules", items: ["Name checked as available on ASIC", "Registered office and principal place of business", "Share classes and price per share", "Constitution or replaceable rules chosen"] },
    { title: "ASIC registration", items: ["Form 201 lodged with ASIC", "ASIC fee paid", "Certificate of registration and ACN saved to Files"] },
    { title: "Tax registrations", items: ["ABN registered", "TFN registered", "GST registered (if needed)", "PAYG withholding registered (if they'll have employees)"] },
    { title: "Company register and handover", items: ["Company register, share certificates and minutes prepared", "Documents signed by directors", "Handover pack sent to the client", "ASIC annual review date noted"] },
    { title: "Set up as a client", items: ["Company added as a new client", "Services ticked (BAS, company tax return, ASIC annual review)", "Bank feeds or bookkeeping set up"] },
  ],
};
for (const [svc, steps] of Object.entries(STEPS)) CHECKLISTS[svc] = steps.flatMap((s) => s.items);
export const checklistFor = (service: string) => CHECKLISTS[service] ?? [];
