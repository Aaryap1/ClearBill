"""
Build the 10-bill synthetic corpus.

    python generate.py            # writes truth/*.json, pages/*_clean.png, *_photo.png,
                                  # defects.md, manifest.json

Ground truth is computed, never typed. Defects are applied after the clean
bill is built and recorded in each truth file. See corpus_spec.py.
"""
import json, os, io, math, random
from datetime import datetime
import corpus_spec as S

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = os.path.join(HERE, "pages")
TRUTH = os.path.join(HERE, "truth")
os.makedirs(PAGES, exist_ok=True)
os.makedirs(TRUTH, exist_ok=True)

def los_days(admit, disch):
    a = datetime.strptime(admit, "%d/%m/%Y %H:%M")
    d = datetime.strptime(disch, "%d/%m/%Y %H:%M")
    return max(1, math.ceil((d - a).total_seconds() / 86400))

# ---------------------------------------------------------------- build clean bill
def build_bill(bid):
    hosp = S.HOSPITALS[bid]
    proc, sec_counts = S.ARCHETYPES[bid]
    pname, page, psex, phid, puhid, roomkind, _ = S.PATIENTS[bid]
    admit, disch = S.STAYS[bid]
    los = los_days(admit, disch)

    sections = []
    for sec, n in sec_counts.items():
        pool = S.POOLS[sec]
        lines = []
        for idx in range(n):
            item, unit, rate = pool[idx % len(pool)]
            qty = S.qty_for(sec, idx, los)
            lines.append({"item": item, "unit": unit, "quantity": float(qty),
                          "rate": float(rate), "total": round(qty * rate, 2), "section": sec})
        if sec == "PHARMACY" and bid in S.DISCHARGE_MEDS_RETURN:
            base = pool[0]
            lines.append({"item": f"PHARMACY RETURN - {base[0]}", "unit": base[1],
                          "quantity": -1.0, "rate": float(base[2]),
                          "total": round(-1 * base[2], 2), "section": sec})
        sections.append({"name": sec, "lines": lines})

    n_lines = sum(len(s["lines"]) for s in sections)
    header = {
        "hospital_name": hosp[0], "hospital_address": hosp[1], "hospital_gstin": hosp[2],
        "hospital_contact": hosp[3], "hospital_registration": hosp[4],
        "bill_number": f"{bid.replace('-', '')}/2026/{1000 + int(bid[-2:]) * 7}",
        "bill_datetime": disch,
        "patient_name": pname, "patient_age": str(page), "patient_gender": psex,
        "patient_hospital_id": phid, "patient_uhid": puhid,
        "patient_address": f"{pname.split()[0]} residence, {hosp[1].split(',')[-1].strip()}",
        "patient_signature": True, "authorised_signature": True,
        "admission_datetime": admit, "discharge_datetime": disch,
        "admission_type": "day-care" if roomkind == "day-care" else "inpatient",
        "procedure": proc, "room_class": roomkind,
        "payment_mode": "cashless (insurance)",
        "insurance_info": "Policy shown; TPA authorisation on file",
    }
    return {"id": bid, "header": header, "sections": sections, "defects_applied": []}

# ---------------------------------------------------------------- apply defects
def apply_defects(bill):
    printed_sub = {}
    for s in bill["sections"]:
        printed_sub[s["name"]] = round(sum(l["total"] for l in s["lines"]), 2)

    recorded = []
    for spec in S.DEFECTS.get(bill["id"], []):
        parts = spec.split(":")
        kind = parts[0]
        if kind == "subtotal_mismatch":
            sec, delta = parts[1], float(parts[2])
            printed_sub[sec] = round(printed_sub[sec] + delta, 2)
            recorded.append({"type": "subtotal_mismatch", "section": sec, "delta": delta,
                "note": f"Printed total for {sec} is {delta:+g} vs the sum of its own lines."})
        elif kind == "duplicate":
            sec, li = parts[1], int(parts[2])
            s = next(x for x in bill["sections"] if x["name"] == sec)
            dup = dict(s["lines"][li])
            s["lines"].insert(li + 1, dup)
            printed_sub[sec] = round(printed_sub[sec] + dup["total"], 2)
            recorded.append({"type": "duplicate", "section": sec, "item": dup["item"],
                "amount": dup["total"],
                "note": f"'{dup['item']}' at Rs {dup['total']:.2f} is printed twice in {sec}."})
        elif kind == "missing_field":
            key = parts[1]
            bill["header"][key] = None
            recorded.append({"type": "missing_field", "field": key,
                "note": f"IS 19493 mandatory field '{key}' is blank on this bill."})
        elif kind == "missing_unit_column":
            for s in bill["sections"]:
                for l in s["lines"]:
                    l["unit"] = None
            recorded.append({"type": "missing_unit_column",
                "note": "The bill has no Unit column; IS 19493 requires one on every charge line."})

    bill["defects_applied"] = recorded
    bill["_printed_subtotals"] = printed_sub
    grand = round(sum(printed_sub.values()), 2)
    disc = round(grand * (0.05 if bill["id"] in {"SYN-01", "SYN-05", "SYN-09"} else 0.0), 2)
    bill["header"]["gross_amount"] = grand
    bill["header"]["discount_amount"] = disc
    bill["header"]["tax_amount"] = 0.0
    bill["header"]["net_payable"] = round(grand - disc, 2)
    return bill

# ---------------------------------------------------------------- truth file
def write_truth(bill):
    lines = [l for s in bill["sections"] for l in s["lines"]]
    truth = {
        "id": bill["id"],
        "header": bill["header"],
        "line_items": lines,
        "printed_subtotals": bill["_printed_subtotals"],
        "printed_grand_total": bill["header"]["gross_amount"],
        "line_count": len(lines),
        "defects": bill["defects_applied"],
        "is_clean": len(bill["defects_applied"]) == 0,
    }
    with open(os.path.join(TRUTH, bill["id"] + ".json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, indent=2, ensure_ascii=False)
    return truth

# ---------------------------------------------------------------- rendering
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

FONT_DIR = "C:/Windows/Fonts"
def _f(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)

F   = lambda s: _f("arial.ttf", s)
FB  = lambda s: _f("arialbd.ttf", s)
FM  = lambda s: _f("consola.ttf", s)
FMB = lambda s: _f("consolab.ttf", s)

W, MARGIN = 1240, 60
INK = (17, 24, 39)
GREY = (90, 100, 115)

def render_clean(bill):
    has_unit = all(l["unit"] is not None for s in bill["sections"] for l in s["lines"])
    h = bill["header"]
    rows_needed = sum(len(s["lines"]) + 2 for s in bill["sections"])
    H = 520 + rows_needed * 26 + 260
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    y = MARGIN

    d.text((MARGIN, y), h["hospital_name"].upper(), font=FB(30), fill=INK); y += 40
    d.text((MARGIN, y), h["hospital_address"], font=F(17), fill=GREY); y += 24
    gst = f'GSTIN: {h["hospital_gstin"]}' if h["hospital_gstin"] else ""
    d.text((MARGIN, y), f'{gst}    Tel: {h["hospital_contact"]}    Reg: {h["hospital_registration"]}', font=F(15), fill=GREY); y += 22
    d.text((MARGIN, y), "HSN code: 9993", font=F(15), fill=GREY); y += 30
    d.line((MARGIN, y, W - MARGIN, y), fill=(200, 205, 215), width=2); y += 18

    d.text((W // 2 - 90, y), "PATIENT BILL (DETAILS)", font=FB(20), fill=INK); y += 34

    def kv(x, k, v):
        d.text((x, y), k, font=F(14), fill=GREY)
        d.text((x + 150, y), str(v if v is not None else "—"), font=FMB(14), fill=INK)
    col2 = W // 2 + 20
    kv(MARGIN, "Bill No.", h["bill_number"]);            kv(col2, "I.P. No.", h["patient_hospital_id"]); y += 24
    kv(MARGIN, "Bill Date", h["bill_datetime"]);         kv(col2, "UHID", h["patient_uhid"]); y += 24
    kv(MARGIN, "Patient Name", h["patient_name"]);       kv(col2, "Age / Sex", f'{h["patient_age"]} / {h["patient_gender"]}'); y += 24
    kv(MARGIN, "Admission", h["admission_datetime"]);    kv(col2, "Discharge", h["discharge_datetime"]); y += 24
    kv(MARGIN, "Admission Type", h["admission_type"]);   kv(col2, "Procedure", h.get("procedure")); y += 24
    kv(MARGIN, "Payment", h["payment_mode"]);            kv(col2, "Class", h.get("room_class")); y += 34

    # table header
    if has_unit:
        cols = [("Date", MARGIN), ("Particulars", MARGIN + 150), ("Unit", 760), ("Qty", 850), ("Rate", 960), ("Amount", 1090)]
    else:
        cols = [("Date", MARGIN), ("Particulars", MARGIN + 150), ("Qty", 880), ("Rate", 980), ("Amount", 1100)]
    d.line((MARGIN, y, W - MARGIN, y), fill=INK, width=2); y += 6
    for name, x in cols:
        d.text((x, y), name, font=FMB(14), fill=INK)
    y += 22
    d.line((MARGIN, y, W - MARGIN, y), fill=(200, 205, 215), width=1); y += 8

    svc_date = h["admission_datetime"].split()[0]
    for s in bill["sections"]:
        d.text((MARGIN, y), s["name"], font=FMB(14), fill=(30, 64, 120)); y += 22
        for l in s["lines"]:
            d.text((MARGIN, y), svc_date, font=FM(12), fill=GREY)
            d.text((MARGIN + 150, y), l["item"][:52], font=FM(13), fill=INK)
            if has_unit:
                d.text((760, y), str(l["unit"]), font=FM(13), fill=INK)
                d.text((850, y), f'{l["quantity"]:g}', font=FM(13), fill=INK)
                d.text((960, y), f'{l["rate"]:,.2f}', font=FM(13), fill=INK)
                d.text((1090, y), f'{l["total"]:,.2f}', font=FM(13), fill=INK)
            else:
                d.text((880, y), f'{l["quantity"]:g}', font=FM(13), fill=INK)
                d.text((980, y), f'{l["rate"]:,.2f}', font=FM(13), fill=INK)
                d.text((1100, y), f'{l["total"]:,.2f}', font=FM(13), fill=INK)
            y += 20
        sub = bill["_printed_subtotals"][s["name"]]
        d.text((MARGIN + 150, y), f'Total for {s["name"]}', font=FMB(13), fill=INK)
        d.text((1090 if has_unit else 1100, y), f'{sub:,.2f}', font=FMB(13), fill=INK)
        y += 12
        d.line((MARGIN, y, W - MARGIN, y), fill=(220, 224, 230), width=1); y += 14

    y += 10
    d.line((MARGIN, y, W - MARGIN, y), fill=INK, width=2); y += 12
    def tot(k, v, bold=False):
        d.text((820, y), k, font=(FMB if bold else FM)(15), fill=INK)
        d.text((1080, y), f'{v:,.2f}', font=(FMB if bold else FM)(15), fill=INK)
    tot("Gross Amount", h["gross_amount"]); y += 24
    tot("Discount", h["discount_amount"]); y += 24
    tot("Tax", h["tax_amount"]); y += 24
    tot("NET PAYABLE", h["net_payable"], bold=True); y += 46

    d.text((MARGIN, y), f'Patient address: {h.get("patient_address", "")}', font=F(13), fill=GREY); y += 40
    d.line((MARGIN, y, MARGIN + 220, y), fill=GREY, width=1)
    d.line((W - MARGIN - 260, y, W - MARGIN, y), fill=GREY, width=1); y += 6
    d.text((MARGIN, y), "Patient / attendant signature", font=F(12), fill=GREY)
    d.text((W - MARGIN - 260, y), "Authorised signatory (hospital)", font=F(12), fill=GREY); y += 34

    d.text((MARGIN, y), "This is a computer-generated synthetic bill for testing. Not a real medical document.",
           font=F(12), fill=(150, 155, 165))
    return img.crop((0, 0, W, min(H, y + 40)))

def degrade(img, seed):
    rnd = random.Random(seed)
    a = img.convert("RGB")
    # rotate — keep small so rows stay locally aligned across the page width
    ang = rnd.uniform(-0.8, 0.8)
    a = a.rotate(ang, expand=True, fillcolor=(238, 236, 232), resample=Image.BICUBIC)
    # very slight horizontal keystone only (no vertical shear — that offsets columns)
    dx = rnd.uniform(-0.010, 0.010)
    a = a.transform(a.size, Image.AFFINE, (1, dx, 0, 0, 1, 0),
                    resample=Image.BICUBIC, fillcolor=(238, 236, 232))
    arr = np.asarray(a).astype(np.float32)
    hh, ww = arr.shape[:2]
    # uneven lighting: diagonal gradient + soft vignette
    gx = np.linspace(rnd.uniform(0.72, 0.9), rnd.uniform(1.02, 1.14), ww)
    gy = np.linspace(rnd.uniform(0.85, 1.0), rnd.uniform(0.88, 1.05), hh)
    light = np.outer(gy, gx)[..., None]
    yy, xx = np.ogrid[:hh, :ww]
    cy, cx = hh * rnd.uniform(0.4, 0.6), ww * rnd.uniform(0.4, 0.6)
    vig = 1 - 0.18 * (((yy - cy) / hh) ** 2 + ((xx - cx) / ww) ** 2) * 4
    arr = arr * light * np.clip(vig, 0.75, 1.0)[..., None]
    # sensor noise
    arr += np.random.default_rng(seed).normal(0, rnd.uniform(2.5, 5.5), arr.shape)
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    a = Image.fromarray(arr)
    # focus blur
    a = a.filter(ImageFilter.GaussianBlur(radius=rnd.uniform(0.5, 1.0)))
    # downscale a touch (phone framing) then JPEG
    scale = rnd.uniform(0.82, 0.96)
    a = a.resize((int(ww * scale), int(hh * scale)), Image.BICUBIC)
    buf = io.BytesIO()
    a.save(buf, "JPEG", quality=rnd.randint(26, 40))
    buf.seek(0)
    return Image.open(buf).convert("RGB")

# ---------------------------------------------------------------- main
def main():
    manifest = []
    for bid in S.HOSPITALS:
        bill = apply_defects(build_bill(bid))
        truth = write_truth(bill)
        clean = render_clean(bill)
        clean.save(os.path.join(PAGES, f"{bid}_clean.png"))
        degrade(clean, seed=int(bid[-2:])).save(os.path.join(PAGES, f"{bid}_photo.png"))
        manifest.append({
            "id": bid, "procedure": bill["header"]["procedure"],
            "lines": truth["line_count"], "grand_total": truth["printed_grand_total"],
            "clean": len(truth["defects"]) == 0,
            "defects": [d["type"] for d in truth["defects"]],
        })
        print(f'{bid}  {truth["line_count"]:>2} lines  Rs {truth["printed_grand_total"]:>12,.2f}  '
              f'{"CLEAN" if truth["is_clean"] else ", ".join(d["type"] for d in truth["defects"])}')

    with open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    with open(os.path.join(HERE, "defects.md"), "w", encoding="utf-8") as f:
        f.write("# Planted defects\n\n")
        f.write("6 of 10 bills carry at least one defect. The other 4 are clean — a\n")
        f.write("checker that flags them is producing false positives.\n\n")
        f.write("| Bill | Procedure | Lines | Clean? | Defects |\n|---|---|---|---|---|\n")
        for m in manifest:
            f.write(f'| {m["id"]} | {m["procedure"]} | {m["lines"]} | '
                    f'{"yes" if m["clean"] else "**no**"} | '
                    f'{"—" if m["clean"] else ", ".join(m["defects"])} |\n')
        f.write("\nExact figures (section, delta, duplicated item) are in each `truth/<id>.json` "
                "under `defects`.\n")
    print("\nwrote manifest.json, defects.md, truth/*.json, pages/*_clean.png, pages/*_photo.png")

if __name__ == "__main__":
    main()
