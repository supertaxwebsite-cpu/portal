/** Standard steps for each type of job. Ticks are saved per job (job_checks). */
const BAS = ["Bank accounts reconciled to statements", "Sales and income checked", "Purchases and GST coding checked", "Payroll / PAYG withholding (W1, W2) agrees to STP", "Fuel tax credits, capital purchases and adjustments checked", "Compared with last period, variances explained", "BAS figures checked by preparer"];
const RETURN = ["Prior year return and notes reviewed", "ATO pre-fill report downloaded", "Income: salary, interest, dividends, rental and other income", "Deductions and receipts checked", "Private health, HELP/HECS and Medicare checked", "Prior year carried forward losses and balances checked", "Workpapers saved in Files"];
const ENTITY = ["Prior year financials and return reviewed", "Bank and loan accounts reconciled", "Trial balance reviewed, coding checked", "GST and BAS figures agree to the ledger", "Payroll, super and PAYG agree to STP", "Div 7A / loans and related party balances checked", "Depreciation and assets register updated", "Tax reconciliation and return prepared", "Workpapers saved in Files"];
// Older processing lists, kept so jobs already ticked against them still show their ticks.
const LEGACY: Record<string, string[]> = {
  itr: RETURN, ctr: ENTITY,
  trust: [...ENTITY.slice(0, -2), "Trust distribution resolution checked", "Beneficiary distributions calculated", "Tax reconciliation and return prepared", "Workpapers saved in Files"],
  partnership: [...ENTITY.slice(0, -2), "Partner distributions calculated", "Tax reconciliation and return prepared", "Workpapers saved in Files"],
  smsf: ["Bank and investment statements received", "Contributions checked against caps", "Pensions and minimum payments checked", "Investment income and market values updated", "Financial statements prepared", "Member statements prepared", "Sent to the auditor", "Audit queries answered"],
  fin: ["Trial balance reviewed", "Balance sheet accounts reconciled", "Profit and loss reviewed against last year", "Notes and statements prepared"],
  fbt: ["Cars and logbooks", "Entertainment and meals", "Loans and other benefits", "Employee contributions", "FBT calculation checked"],
  tpar: ["Contractor payments listed", "ABNs and details checked", "Totals agree to the ledger"],
  ias: ["PAYG instalment amount or rate checked", "PAYG withholding agrees to STP", "Compared with last period"],
};

// ---------- Company tax return ----------
const CTR_PROC = [
  "All bank, loan and credit card accounts reconciled to the 30 June statements",
  "Whole-year sales and income checked against invoices and bank deposits",
  "Whole-year expenses checked: coding, private use and capital items taken out",
  "GST reconciled: ledger agrees to the four BAS lodged, differences adjusted",
  "Wages, PAYG withholding and super agree to the STP finalisation",
  "Super paid by the due date to be deductible this year (super guarantee and director super)",
  "Debtors, creditors, accruals and prepayments brought to account at 30 June",
  "Closing stock and work in progress recorded (stocktake received)",
  "Depreciation worked out and asset register updated (instant asset write-off or small business pool)",
  "Asset sales: profit or loss and any capital gain worked out",
  "Shareholder and director loans checked for Division 7A (minimum repayment made or loan agreement in place)",
  "Related party transactions, directors' fees and dividends checked",
  "ATO integrated client account and income tax account agree to the ledger (GST, PAYG withholding, instalments, tax payable)",
  "PAYG instalments paid this year credited against the tax",
  "Franking account updated, no franking deficit, dividend statements issued",
  "Tax reconciliation: non-deductible items added back (entertainment, fines, private use, penalties)",
  "Carried forward tax losses checked (continuity of ownership or same business test)",
  "Tax rate confirmed: base rate entity 25% or 30%",
  "FBT, R&D, fuel tax credits and other schedules considered",
  "Financial statements and company tax return prepared",
  "Workpapers saved in Files",
];
const CTR = {
  ir: ["Prior year tax return, financial statements and workpapers reviewed", "ATO portal checked: integrated client account, income tax account and lodgment list downloaded", "All BAS lodged for the year downloaded", "Bank, loan and credit card statements to 30 June received", "STP finalisation, payroll summary and super payment report received", "Asset purchases and sales listed with invoices", "Opening balances agree to last year's balance sheet", "Anything missing listed (raise a query for it)"],
  proc: CTR_PROC,
  review: ["Financial statements and tax return agree (profit, equity, tax payable)", "Balance sheet accounts tie to statements and reconciliations", "GST, PAYG withholding and super reconciliations checked", "Division 7A and related party loans checked", "Tax rate, losses and franking account checked", "Compared with last year, big movements explained", "Review notes cleared"],
  sign: ["Financial statements, tax return and summary of tax payable prepared", "Directors' declaration and minutes prepared", "Tax payable or refund and due date explained to the client", "Sent for signing", "Signed declaration saved in Files"],
  lodge: ["Company tax return lodged with the ATO", "Lodgment receipt saved in Files", "Payment details (PRN and due date) sent to the client", "Next year's PAYG instalment amount or rate noted", "ASIC details and annual review date checked"],
};

// ---------- Individual tax return ----------
const ITR = {
  ir: ["Prior year return and notes reviewed", "ATO pre-fill report downloaded (income statements, interest, dividends, private health)", "Client's documents received: income statements, interest, dividends and receipts", "ABN or sole trader records received (sales, expenses, BAS lodged)", "Rental property papers received: agent's annual statement, loan interest, rates, insurance", "Shares, crypto or property sold this year listed (buy and sell details)", "Spouse income, dependants and private health details confirmed", "Anything missing listed (raise a query for it)"],
  proc: [
    "Income verified: salary and wages agree to income statements marked tax ready",
    "Allowances, lump sums, termination payments and government payments checked",
    "Interest, dividends and franking credits agree to pre-fill and statements",
    "ABN income verified: sales agree to bank and BAS, expenses checked, personal services income rules checked",
    "Partnership and trust distributions entered from the entity's return",
    "Investment property: rent, agent fees, interest, rates, insurance and repairs (capital items taken out)",
    "Investment property: depreciation schedule, days rented and ownership share checked",
    "Capital gains: cost base, sale price, 12-month discount and prior capital losses",
    "Foreign income and foreign tax offset checked",
    "Work-related deductions checked against receipts (car, home office, travel, self-education, clothing)",
    "Donations, tax agent fees and income protection insurance",
    "Personal super contributions: notice of intent lodged and acknowledged",
    "Private health insurance statement and Medicare levy surcharge checked",
    "HELP or study loan and Medicare levy exemptions checked",
    "Tax offsets checked (seniors and pensioners, zone, invalid carer)",
    "Prior year losses carried forward",
    "Estimated refund or tax payable worked out and compared with last year",
    "Workpapers saved in Files",
  ],
  review: ["Income agrees to pre-fill, anything extra explained", "Deductions supported and reasonable compared with last year", "Business, rental and capital gains schedules checked", "Medicare, private health and HELP checked", "Refund or payable compared with last year, big changes explained", "Review notes cleared"],
  sign: ["Return and estimate summary prepared for the client", "Refund or amount payable explained to the client", "Sent for signing (client declaration)", "Signed declaration saved in Files"],
  lodge: ["Tax return lodged with the ATO", "Lodgment receipt saved in Files", "Client told the refund or amount to pay and the due date", "PAYG instalment notice explained (if one is coming)"],
};

// ---------- Trusts and partnerships share most of the company work ----------
const ENTITY_IR = (deed: string) => ["Prior year tax return, financial statements and workpapers reviewed", deed, "ATO portal checked: integrated client account, income tax account and lodgment list downloaded", "All BAS lodged for the year downloaded", "Bank, loan and credit card statements to 30 June received", "Payroll, STP finalisation and super reports received (if employees)", "Asset purchases and sales listed with invoices", "Anything missing listed (raise a query for it)"];
const ENTITY_BOOKS = CTR_PROC.slice(0, 11).filter((i) => !i.startsWith("Shareholder"));
const TRUST = {
  ir: ENTITY_IR("Trust deed checked: trustee, beneficiaries, income definition and vesting date"),
  proc: [
    ...ENTITY_BOOKS,
    "Loans to beneficiaries and unpaid present entitlements to a company checked (Division 7A)",
    "ATO integrated client account agrees to the ledger (GST, PAYG withholding, instalments)",
    "Distribution resolution made by 30 June as the deed requires",
    "Trust net income worked out and compared with accounting (distributable) income",
    "Capital gains and franked dividends streamed correctly (if the deed allows)",
    "Section 100A checked: distributions actually benefit the beneficiaries",
    "Family trust election and interposed entity elections checked",
    "Beneficiary TFNs and trustee beneficiary reporting checked",
    "Distributions to minors and non-residents checked (tax withheld where needed)",
    "Trust losses and carried forward losses checked",
    "Financial statements, trust tax return and beneficiary statements prepared",
    "Workpapers saved in Files",
  ],
  review: ["Financial statements and tax return agree", "Distribution resolution matches the return and beneficiary statements", "Balance sheet accounts tie to statements and reconciliations", "Division 7A, section 100A and trust elections checked", "Compared with last year, big movements explained", "Review notes cleared"],
  sign: ["Financial statements, distribution minutes and tax return prepared", "Distribution to each beneficiary explained to the trustee", "Sent for signing", "Signed declaration and minutes saved in Files"],
  lodge: ["Trust tax return lodged with the ATO", "Lodgment receipt saved in Files", "Each beneficiary's share sent for their own returns", "Next year's distribution resolution date noted (before 30 June)"],
};
const PARTNERSHIP = {
  ir: ENTITY_IR("Partnership agreement checked: partners and profit-sharing ratio"),
  proc: [
    ...ENTITY_BOOKS,
    "ATO integrated client account agrees to the ledger (GST, PAYG withholding)",
    "Partner drawings, salaries and capital accounts checked",
    "Net income worked out and split by the profit-sharing ratio",
    "Partners' interest on capital and related party transactions checked",
    "Personal services income and non-commercial loss rules checked",
    "Financial statements, partnership return and partner statements prepared",
    "Workpapers saved in Files",
  ],
  review: ["Financial statements and return agree", "Profit split matches the agreement and partner statements", "Balance sheet accounts tie to statements and reconciliations", "Compared with last year, big movements explained", "Review notes cleared"],
  sign: ["Financial statements and partnership return prepared", "Each partner's share explained", "Sent for signing", "Signed declaration saved in Files"],
  lodge: ["Partnership return lodged with the ATO", "Lodgment receipt saved in Files", "Each partner's share sent for their own returns"],
};

// ---------- SMSF ----------
const SMSF = {
  ir: ["Prior year financials, audit report and annual return reviewed", "Bank and investment statements to 30 June received", "Contribution details received (employer, personal, notices of intent)", "Pension details received (amounts paid, start dates)", "Investment documents received (property, shares, managed funds, crypto)", "Trust deed and investment strategy on file", "Anything missing listed (raise a query for it)"],
  proc: [
    "Bank and investment accounts reconciled to 30 June statements",
    "Contributions recorded and checked against concessional and non-concessional caps",
    "Members' total super balance and transfer balance account checked",
    "Pension minimum payments made, transfer balance account reports lodged",
    "Investment income, distributions and franking credits agree to tax statements",
    "Market values at 30 June updated (property valuation, shares, managed funds)",
    "Exempt pension income worked out (actuarial certificate if needed)",
    "In-house assets under 5%, related party transactions and sole purpose test checked",
    "Investment strategy reviewed and signed",
    "Financial statements and member statements prepared",
    "SMSF annual return prepared",
    "Sent to the auditor",
    "Audit queries answered and audit report received",
    "Workpapers saved in Files",
  ],
  review: ["Financial statements, member statements and return agree", "Contributions and caps checked", "Pensions and minimum payments checked", "Market values and investment income checked", "Audit report received with no unresolved issues", "Review notes cleared"],
  sign: ["Financial statements, member statements and return prepared", "Trustee declarations and minutes prepared", "Sent for signing", "Signed documents saved in Files"],
  lodge: ["SMSF annual return lodged with auditor details", "Lodgment receipt saved in Files", "Supervisory levy and any tax paid, client told the amount", "Members told their balances"],
};

// ---------- Others ----------
const FIN = {
  ir: ["Prior year financial statements reviewed", "Trial balance and general ledger received", "Bank and loan statements to balance date received", "Anything missing listed (raise a query for it)"],
  proc: ["Bank and loan accounts reconciled", "Trial balance reviewed, coding checked", "Balance sheet accounts reconciled (debtors, creditors, GST, payroll, loans)", "Depreciation and asset register updated", "Accruals, prepayments and stock brought to account", "Profit and loss compared with last year, variances explained", "Notes, statements and directors' declaration prepared", "Workpapers saved in Files"],
};
const FBT = {
  ir: ["Prior year FBT return reviewed", "List of employees and benefits received", "Car logbooks, odometer readings and running costs received", "Entertainment, loans and other benefit records received", "Anything missing listed (raise a query for it)"],
  proc: ["Cars: statutory or logbook method, days available and employee contributions", "Car parking benefits checked", "Entertainment and meals: 50/50 split or actual method", "Loans, expense payments and housing benefits", "Living away from home allowances checked", "Exempt benefits taken out (portable devices, minor benefits under $300)", "Employee contributions recorded", "Gross-up type 1 and type 2 and FBT payable worked out", "Reportable fringe benefits worked out for STP", "FBT return prepared", "Workpapers saved in Files"],
};
const TPAR = {
  proc: ["Industry checked: building, cleaning, courier, road freight, IT, security or government grants", "Contractor payments listed from the ledger", "ABNs checked on the ABN lookup, names and addresses correct", "Amounts paid include GST where charged", "Totals agree to the ledger", "TPAR prepared (due 28 August)"],
};
const IAS = {
  proc: ["PAYG instalment amount or rate checked against the ATO notice", "Instalment income worked out (if using the rate)", "Variation considered if income has changed", "PAYG withholding agrees to STP", "Compared with last period"],
};

export const CHECKLISTS: Record<string, string[]> = {
  bas: BAS,
  ias: IAS.proc,
  payroll: ["Timesheets and pay changes received", "Pay run processed and checked", "Super calculated", "STP lodged", "Payslips sent"],
  bookkeeping: ["Bank feeds up to date", "Transactions coded", "Receipts and invoices matched", "Bank reconciled", "Queries listed for the client"],
  itr: ITR.proc,
  ctr: CTR.proc,
  trust: TRUST.proc,
  partnership: PARTNERSHIP.proc,
  smsf: SMSF.proc,
  fin: FIN.proc,
  fbt: FBT.proc,
  tpar: TPAR.proc,
  ato_payment: ["Amount and due date taken from the ATO account", "Payment reference (PRN) and BPAY / card details sent to the client", "Payment plan set up if they can't pay in full", "Client confirms it's paid", "Payment shows on the ATO account"],
  sgc: ["Employees and quarters with late or missed super listed", "Shortfall, interest and admin fee worked out", "SGC statement lodged by the due date", "Client told the amount and how to pay", "Late payment offset recorded (if any)"],
  ato_comm: ["Letter saved to Files and deadline noted", "Reply, objection or extension request prepared", "Penalty or interest remission asked for (if it fits)", "Copy sent to the client", "Followed up until the ATO confirms"],
  company_formation: [] as string[],
  asic: ["Company statement reviewed", "Details updated with ASIC", "Annual fee paid or invoiced", "Solvency resolution signed"],
};

/** First task on every job: look over what the client sent and get the data into the software. */
export const IR_DEFAULT = [
  "All documents from the client received and checked",
  "Bank statements uploaded into the accounting software",
  "Bank transactions processed and coded",
  "Anything missing listed (raise a query for it)",
];
const REVIEW_DEFAULT = ["Workpapers and source documents checked", "Figures agree to the ledger and source documents", "Compared with last period, variances explained", "Review notes cleared"];
const SIGN_DEFAULT = ["Documents and summary prepared for the client", "Amount payable or refund and due date explained", "Sent for signing", "Signed copy saved in Files"];
const LODGE_DEFAULT = ["Lodged with the ATO", "Lodgment receipt saved in Files", "Payment or refund details sent to the client", "Next due date noted"];
const BAS_LODGE = ["BAS lodged with the ATO", "Lodgment receipt saved in Files", "Amount payable, PRN and due date sent to the client"];
interface Lists { ir: string[]; review: string[]; sign: string[]; lodge: string[] }
const TASKS: Record<string, Partial<Lists>> = {
  ctr: CTR, itr: ITR, trust: TRUST, partnership: PARTNERSHIP, smsf: SMSF, fin: FIN, fbt: FBT,
  tpar: { lodge: ["TPAR lodged with the ATO", "Lodgment receipt saved in Files"] },
  bas: { lodge: BAS_LODGE }, ias: { lodge: BAS_LODGE },
};
TASKS.fbt = { ...FBT, lodge: ["FBT return lodged with the ATO", "Lodgment receipt saved in Files", "FBT payable and due date sent to the client", "Next year's FBT instalments noted"] };

/** Checklist keys: Initial review "IR: x", Review "RV: x", Client signature "SG: x", Lodge "LG: x", Processing just "x". */
export const KEY = { ir: (i: string) => `IR: ${i}`, review: (i: string) => `RV: ${i}`, sign: (i: string) => `SG: ${i}`, lodge: (i: string) => `LG: ${i}` };
const plain = (k: string) => k.replace(/^N\/A: /, "");

/** Every task's checklist for a job type. Jobs ticked against an older list keep that list. */
export function taskLists(service: string, ticked: string[] = []) {
  const t = TASKS[service] ?? {};
  const has = new Set(ticked.map(plain));
  let proc = CHECKLISTS[service] ?? [];
  const old = LEGACY[service];
  if (old && old.some((i) => has.has(i) && !proc.includes(i))) proc = old;
  let ir = t.ir ?? IR_DEFAULT;
  if (ir !== IR_DEFAULT && IR_DEFAULT.some((i) => has.has(KEY.ir(i)) && !ir.includes(i))) ir = IR_DEFAULT;
  return { ir, proc, review: t.review ?? REVIEW_DEFAULT, sign: t.sign ?? SIGN_DEFAULT, lodge: t.lodge ?? LODGE_DEFAULT };
}
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
