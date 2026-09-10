import pymupdf, re, sys, os

SRC = sys.argv[1]
OUT = "bill_redacted.pdf"
PNGDIR = "pages"

# Terms to black out are read from a LOCAL, git-ignored file so that no personal
# data (names, policy/claim IDs, phone numbers, diagnosis...) is ever committed.
# Put one literal per line in 03_code/redact_terms.local.txt. Never short
# numbers - they collide with rupee amounts.
_TERMS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "redact_terms.local.txt")
if not os.path.exists(_TERMS_FILE):
    sys.exit("Create 03_code/redact_terms.local.txt (one term per line) - see the comment above.")
TERMS = [t.strip() for t in open(_TERMS_FILE, encoding="utf-8").read().splitlines()
         if t.strip() and not t.strip().startswith("#")]

# Barcodes survive number-blackout: the bars still decode. Blank the whole region.
# Some text is image-only with no text layer, so nothing can search it.
# Coordinates are fractions of the page: page -> list of (x0,y0,x1,y1)
ZONES = {
    2: [(0.68, 0.10, 0.92, 0.19)],                       # barcode (bars decode even if the number is blacked)
    4: [(0.05, 0.232, 0.26, 0.260)],                     # GSTIN, drawn as pixels only
    5: [(0.05, 0.03, 0.95, 0.075)],                      # header band
    6: [(0.05, 0.03, 0.95, 0.075)],
}

# Word matching misses values that sit beside a label. Blank the whole value cell instead.
BLANK_RIGHT_OF = [
    "Patient Name", "Age", "Gender", "Insurance Company", "Policy Holder",
    "Policy No", "Primary Beneficiary", "Insurer Claim No", "Insurer Member ID",
    "Provisional Diagnosis", "Treating Doctor", "Consultant", "Address", "Phone",
    "Sponsor", "Payer", "Network", "Rohini Id", "Hospital ID", "I.P. No", "Claim No",
]

# Regex catches anything the literals miss: GSTIN, CIN, phones, long ID runs.
PATTERNS = [
    r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}\b",   # GSTIN
    r"\b[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b",   # CIN
    r"\b[6-9]\d{9}\b",                             # Indian mobile
    r"\b\d{11,}\b",                                # long ID runs (amounts are far shorter)
]

doc = pymupdf.open(SRC)
lit_hits, rx_hits = {}, []

for page in doc:
    for term in TERMS:
        for rect in page.search_for(term):
            page.add_redact_annot(rect, fill=(0, 0, 0))
            lit_hits[term] = lit_hits.get(term, 0) + 1
    # regex pass over individual words
    for w in page.get_text("words"):
        x0, y0, x1, y1, word = w[0], w[1], w[2], w[3], w[4]
        for pat in PATTERNS:
            if re.fullmatch(pat, word) or re.search(pat, word):
                page.add_redact_annot(pymupdf.Rect(x0, y0, x1, y1), fill=(0, 0, 0))
                rx_hits.append(word)
                break
    for label in BLANK_RIGHT_OF:
        for lr in page.search_for(label):
            page.add_redact_annot(pymupdf.Rect(
                lr.x1 + 2, lr.y0 - 2,
                page.rect.x0 + 0.90 * page.rect.width, lr.y1 + 2), fill=(0, 0, 0))
    for z in ZONES.get(page.number + 1, []):
        r = page.rect
        page.add_redact_annot(pymupdf.Rect(
            r.x0 + z[0]*r.width, r.y0 + z[1]*r.height,
            r.x0 + z[2]*r.width, r.y0 + z[3]*r.height), fill=(0, 0, 0))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS)

doc.save(OUT, garbage=4, deflate=True)

print(f"literal redactions : {sum(lit_hits.values())}")
missing = [t for t in TERMS if t not in lit_hits]
print(f"literals not found : {missing}")
print(f"regex redactions   : {len(rx_hits)} -> {sorted(set(rx_hits))}")

os.makedirs(PNGDIR, exist_ok=True)
d2 = pymupdf.open(OUT)
for i, page in enumerate(d2, 1):
    page.get_pixmap(dpi=200).save(f"{PNGDIR}/page_{i}.png")

alltext = "".join(p.get_text() for p in d2)
print("\nLEAK CHECK")
leaks = [t for t in TERMS if t in alltext]
leaks += [m for pat in PATTERNS for m in re.findall(pat, alltext)]
print("  " + ("CLEAN" if not leaks else f"STILL PRESENT: {leaks}"))

print("\nDATA THAT MUST SURVIVE")
for v in ["41395.92","41396","30476","5962","3387","1572","9349","4500","11580","5790","1040","850","53.27","1260","2699.75","1456.17"]:
    print(("  ok   " if v in alltext else "  GONE ") + v)
