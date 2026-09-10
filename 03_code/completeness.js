// ClearBill — IS 19493 completeness check
// -----------------------------------------------------------------------------
// IS 19493:2025 is the Bureau of Indian Standards guideline for a standardised,
// patient-readable hospital bill. It is currently VOLUNTARY (BIS/press, 2025;
// expected to become mandatory ~2027). So this check reports what the standard
// *expects*, not a legal violation. Contrast NPPA ceilings, which are statutory.
//
// Same architecture rule as the matcher: code judges, and every line of the
// report names the element of the standard it came from. Nothing is inferred.
//
// Two layers:
//   HEADER    — identity / patient / admission fields that must appear once.
//   LINE ITEM — IS 19493 requires every charge to show unit, quantity,
//               price per unit and total. This is checkable on data we
//               already extract.
// -----------------------------------------------------------------------------

// --- the field registry ------------------------------------------------------
// area:  the clause group in IS 19493:2025 (BIS press summary wording)
// sev:   "mandatory" | "conditional"  (conditional = only if applicable/requested)
const HEADER_FIELDS = [
  // Healthcare organisation
  { key: "hospital_name",        label: "Hospital name",                 area: "Healthcare organisation", sev: "mandatory" },
  { key: "hospital_address",     label: "Hospital address",              area: "Healthcare organisation", sev: "mandatory" },
  { key: "hospital_gstin",       label: "Hospital GSTIN (15 digit)",     area: "Healthcare organisation", sev: "mandatory", format: /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}$/ },
  { key: "hospital_contact",     label: "Hospital phone / email",        area: "Healthcare organisation", sev: "mandatory" },
  { key: "hospital_registration",label: "Registration / licence number", area: "Healthcare organisation", sev: "mandatory" },
  { key: "hospital_accreditation",label:"Accreditation details (e.g. NABH)",area:"Healthcare organisation", sev: "conditional" },
  // Bill identity
  { key: "bill_number",          label: "Unique bill number",            area: "Bill identity",           sev: "mandatory" },
  { key: "bill_datetime",        label: "Bill generation date & time",   area: "Bill identity",           sev: "mandatory" },
  // Patient
  { key: "patient_name",         label: "Patient name",                  area: "Patient",                 sev: "mandatory" },
  { key: "patient_age",          label: "Patient age",                   area: "Patient",                 sev: "mandatory" },
  { key: "patient_gender",       label: "Patient gender",                area: "Patient",                 sev: "mandatory" },
  { key: "patient_hospital_id",  label: "Hospital patient ID / IP no.",  area: "Patient",                 sev: "mandatory" },
  { key: "patient_uhid",         label: "Unique Health ID (UHID / ABHA)",area: "Patient",                 sev: "mandatory" },
  { key: "patient_address",      label: "Patient address",               area: "Patient",                 sev: "mandatory" },
  { key: "patient_gstin",        label: "Patient GSTIN",                 area: "Patient",                 sev: "conditional" },
  // Admission / discharge
  { key: "admission_datetime",   label: "Date & time of admission",      area: "Admission / discharge",   sev: "mandatory" },
  { key: "discharge_datetime",   label: "Date & time of discharge",      area: "Admission / discharge",   sev: "mandatory" },
  { key: "admission_type",       label: "Admission type (IP / OP / day-care)", area: "Admission / discharge", sev: "mandatory" },
  // Financial summary
  { key: "gross_amount",         label: "Gross amount",                  area: "Financial summary",       sev: "mandatory" },
  { key: "discount_amount",      label: "Discount",                      area: "Financial summary",       sev: "mandatory" },
  { key: "tax_amount",           label: "Taxes",                         area: "Financial summary",       sev: "mandatory" },
  { key: "net_payable",          label: "Net payable amount",            area: "Financial summary",       sev: "mandatory" },
  { key: "payment_mode",         label: "Payment mode",                  area: "Financial summary",       sev: "mandatory" },
  { key: "insurance_info",       label: "Insurance / TPA coverage info", area: "Financial summary",       sev: "conditional" },
  // Signatures
  { key: "patient_signature",    label: "Patient / next-of-kin signature", area: "Attestation",           sev: "mandatory" },
  { key: "authorised_signature", label: "Authorised signatory",          area: "Attestation",             sev: "mandatory" },
];

// IS 19493 line-item requirement: each charge shows these four.
const LINE_FIELDS = [
  { key: "item",     label: "Description" },
  { key: "unit",     label: "Unit" },
  { key: "quantity", label: "Quantity" },
  { key: "rate",     label: "Price per unit" },
  { key: "total",    label: "Total" },
];

// IS 19493 billing categories charges should be grouped under.
const IS_CATEGORIES = [
  "room charges", "consultation", "procedures / surgery", "investigation / diagnostics",
  "pharmacy / medicines", "consumables / disposables", "package charges", "miscellaneous",
];

// --- helpers ---------------------------------------------------------------
const isBlank = (v) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") ||
  (typeof v === "string" && /^(n\/?a|nil|none|-|--|not available)$/i.test(v.trim()));

// A field can be blank for two different reasons, and they are not the same
// claim. "missing" means the hospital did not print it — that is a finding
// against the bill. "redacted" means we removed it ourselves before analysis;
// nothing can be concluded from its absence. Counting the second as the first
// would fabricate findings against a real hospital, which is exactly the
// failure this project exists to argue against.
//
// redactedFields: keys destroyed by our own redaction pipeline. Callers pass
// bill._redacted_header_fields; when absent, behaviour is unchanged.
function checkHeader(header = {}, redactedFields = []) {
  const redacted = new Set(redactedFields);
  const rows = HEADER_FIELDS.map((f) => {
    const raw = header[f.key];
    let status;
    if (isBlank(raw)) status = redacted.has(f.key) ? "redacted" : "missing";
    else if (f.format && !f.format.test(String(raw).replace(/\s/g, ""))) status = "malformed";
    else status = "present";
    return { ...f, value: raw ?? null, status };
  });
  return rows;
}

function checkLines(lines = []) {
  const perField = {};
  for (const f of LINE_FIELDS) perField[f.key] = { label: f.label, missing: 0, total: lines.length, examples: [] };
  lines.forEach((l, i) => {
    for (const f of LINE_FIELDS) {
      const v = l[f.key];
      const blank = f.key === "quantity" || f.key === "rate" || f.key === "total"
        ? (v === null || v === undefined || Number.isNaN(Number(v)))
        : isBlank(v);
      if (blank) {
        perField[f.key].missing++;
        if (perField[f.key].examples.length < 3) perField[f.key].examples.push(l.item || `line ${i + 1}`);
      }
    }
  });
  return perField;
}

function checkCategories(lines = []) {
  const present = new Set(lines.map((l) => String(l.category || l.section || "").toLowerCase().trim()).filter(Boolean));
  return { present: [...present], grouped: present.size > 0 };
}

function checkCompleteness(bill = {}) {
  const redactedFields = bill._redacted_header_fields || [];
  const header = checkHeader(bill.header || {}, redactedFields);
  const lines = checkLines(bill.line_items || []);
  const cats = checkCategories(bill.line_items || []);

  const mand = header.filter((r) => r.sev === "mandatory");
  const mandPresent = mand.filter((r) => r.status === "present").length;
  const mandRedacted = mand.filter((r) => r.status === "redacted").length;
  // Redacted fields leave the denominator: we cannot assess what we deleted,
  // so scoring against them would understate the bill for our own reasons.
  const assessable = mand.length - mandRedacted;
  const headerScore = assessable > 0 ? Math.round((mandPresent / assessable) * 100) : null;

  const lineIssues = Object.entries(lines).filter(([, v]) => v.missing > 0);
  const lineFieldsOk = LINE_FIELDS.length - lineIssues.length;
  const lineScore = Math.round((lineFieldsOk / LINE_FIELDS.length) * 100);

  // plain-language summary lines — never accusatory
  const summary = [];
  const missMand = header.filter((r) => r.sev === "mandatory" && r.status === "missing").map((r) => r.label);
  const redMand = header.filter((r) => r.sev === "mandatory" && r.status === "redacted").map((r) => r.label);
  const malformed = header.filter((r) => r.status === "malformed").map((r) => r.label);
  if (missMand.length)
    summary.push(
      `IS 19493:2025 expects ${mand.length} mandatory header fields` +
      (redMand.length ? `, of which ${assessable} can be assessed on this copy` : "") +
      `. ${missMand.length} are not on this bill: ${missMand.join(", ")}.`);
  if (redMand.length)
    summary.push(
      `${redMand.length} further field${redMand.length > 1 ? "s were" : " was"} removed by redaction before ` +
      `analysis and cannot be assessed — nothing is claimed about ${redMand.length > 1 ? "them" : "it"}: ` +
      `${redMand.join(", ")}.`);
  if (malformed.length)
    summary.push(`Present but not in the expected format: ${malformed.join(", ")}.`);
  for (const [k, v] of lineIssues) {
    if (v.missing === v.total)
      summary.push(v.total === 1
        ? `The single charge line is missing the "${v.label}" column that IS 19493 requires.`
        : `Every one of the ${v.total} charge lines is missing the "${v.label}" column that IS 19493 requires.`);
    else
      summary.push(`${v.missing} of ${v.total} charge lines are missing "${v.label}" (e.g. ${v.examples.join("; ")}).`);
  }
  if (!cats.grouped)
    summary.push(`Charges are not grouped under billing categories (IS 19493 lists: ${IS_CATEGORIES.join(", ")}).`);
  if (!summary.length) summary.push("This bill carries every element IS 19493:2025 asks for.");

  return {
    standard: "IS 19493:2025 (voluntary BIS guideline — not a statutory requirement)",
    header_rows: header,
    header_score_pct: headerScore,
    header_mandatory_count: mand.length,
    header_assessable_count: assessable,
    header_missing_mandatory: missMand,
    header_redacted_mandatory: redMand,
    line_field_report: lines,
    line_score_pct: lineScore,
    categories: cats,
    summary,
  };
}

if (typeof module !== "undefined")
  module.exports = { checkCompleteness, checkHeader, checkLines, HEADER_FIELDS, LINE_FIELDS, IS_CATEGORIES };
