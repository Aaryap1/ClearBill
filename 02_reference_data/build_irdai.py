import csv

SRC = "IRDAI List of Non-Medical / Non-Payable Items (as circulated by insurers)"
EFF = "2017-01-01"   # verify against the current IRDAI master circular before shipping

# (item, category, match_keywords pipe-separated, confidence)
# confidence: exact  = named in the list, unambiguous
#             likely = clearly the same thing under a different trade name
#             review = commonly deducted but NOT explicitly listed - never auto-flag
ROWS = [
 # --- administrative ---
 ("Admission/Registration Charges","administrative","admission service|registration charge|admission charge","exact"),
 ("Medical Records","administrative","medical record","exact"),
 ("Documentation Charges / Administrative Expenses","administrative","documentation charge|administrative expense|admin charge","exact"),
 ("TPA Charges","administrative","tpa charge|insurance processing|insurance charge","exact"),
 ("Discharge Procedure Charges","administrative","discharge procedure|discharge charge","exact"),
 ("Certificate Charges","administrative","certificate charge","exact"),
 ("Medical Certificate","administrative","medical certificate","exact"),
 ("Birth Certificate","administrative","birth certificate","exact"),
 ("Photocopies Charges","administrative","photocopy|photocopies|xerox","exact"),
 ("Courier Charges","administrative","courier","exact"),
 ("Conveyance Charges","administrative","conveyance","exact"),
 ("Medico Legal Case Charges","administrative","medico legal|mlc charge","exact"),
 ("Maintenance Charges","administrative","maintenance charge","exact"),
 ("Surcharges","administrative","surcharge","exact"),
 ("Attendant Charges","administrative","attendant charge","exact"),
 ("Entrance Pass / Visitors Pass Charges","administrative","visitor pass|entrance pass","exact"),
 ("Incidental Expenses / Misc. Charges","administrative","incidental|miscellaneous charge|misc charge","exact"),
 ("Daily Chart Charges","administrative","daily chart","exact"),
 ("Diabetic Chart Charges","administrative","diabetic chart","exact"),
 ("Preparation Charges","administrative","preparation charge","exact"),
 ("Patient Identification Band / Name Tag","administrative","identification band|name tag|id band","exact"),
 ("Blood Reservation Charges / Ante Natal Booking","administrative","blood reservation|ante natal booking","exact"),
 ("Service Charges Where Nursing Charge Also Charged","administrative","service charge","review"),
 ("Referral Doctor's Fees","administrative","referral doctor|referral fee","exact"),

 # --- hygiene / scrub / swabs ---
 ("Alcohol Swabs","hygiene","alco swab|alcohol swab|alcohol gauze","exact"),
 ("Scrub Solution / Sterillium","hygiene","sterillium|scrub solution|propanol|alcorub|povidone scrub|hand rub","exact"),
 ("Savlon","hygiene","savlon","exact"),
 ("Hand Wash","hygiene","hand wash","exact"),
 ("Micro Shield","hygiene","micro shield|microshield","exact"),
 ("Washing Charges","hygiene","washing charge","exact"),
 ("Laundry Charges","hygiene","laundry","exact"),
 ("Clean Sheet","hygiene","clean sheet","exact"),

 # --- gloves / masks / covers ---
 ("Examination Gloves","consumable","gloves examination|examination glove|exam glove|nitrile glove|glove nitrile|examination medium nitrile","exact"),
 ("Surgical Gloves (sterile, in-procedure)","consumable","surgical glove|glove size|gammex|encore","review"),
 ("Paper Gloves","consumable","paper glove","exact"),
 ("Mask","consumable","face mask|flexi mask|surgical mask","exact"),
 ("Apron","consumable","apron","exact"),
 ("Gown","consumable","gown","exact"),
 ("Shoe Cover","consumable","shoe cover|foot cover","exact"),
 ("Caps","consumable","surgical cap|theatre cap","exact"),
 ("Camera Cover","consumable","camera cover","exact"),
 ("Trolly Cover","consumable","trolley cover|trolly cover","exact"),
 ("Carry Bags","consumable","carry bag","exact"),

 # --- dressings / minor disposables ---
 ("Band Aids, Bandages, Sterile Injections, Needles, Syringes","consumable","band aid|bandaid","exact"),
 ("Cotton","consumable","cotton roll|absorbent cotton","exact"),
 ("Cotton Bandage","consumable","cotton bandage","exact"),
 ("Crepe Bandage","consumable","crepe bandage","exact"),
 ("Hansaplast / Adhesive Bandages","consumable","hansaplast|adhesive bandage","exact"),
 ("Gauze","consumable","gauze|gauge soft","exact"),
 ("Cliniplast","consumable","cliniplast","exact"),
 ("Curapore","consumable","curapore","exact"),
 ("Blade","consumable","blade","review"),
 ("Tourniquet","consumable","tourniquet","exact"),
 ("Eyelet Collar","consumable","eyelet collar","exact"),
 ("Eye Pad","consumable","eye pad","exact"),
 ("Eye Shield","consumable","eye shield","exact"),

 # --- ward / room items ---
 ("Bed Pan","ward","bed pan|bedpan","exact"),
 ("Bed Under Pad Charges","ward","under pad|underpad","exact"),
 ("Diaper of Any Type","ward","diaper","exact"),
 ("Blanket / Warmer Blanket","ward","blanket","exact"),
 ("Admission Kit","ward","admission kit","exact"),
 ("Kidney Tray","ward","kidney tray","exact"),
 ("Ounce Glass","ward","ounce glass","exact"),
 ("Urine Container","ward","urine container","exact"),
 ("Urometer, Urine Jug","ward","urometer|urine jug","exact"),
 ("Medicine Box","ward","medicine box","exact"),
 ("Thermometer","ward","thermometer","exact"),
 ("Comb","toiletries","comb","exact"),
 ("Brush","toiletries","tooth brush|toothbrush","exact"),
 ("Tooth Paste","toiletries","tooth paste|toothpaste","exact"),
 ("Towel","toiletries","towel|cosy towel","exact"),
 ("Slippers","toiletries","slipper","exact"),
 ("Sanitary Pad","toiletries","sanitary pad","exact"),
 ("Tissue Paper","toiletries","tissue paper","exact"),
 ("Powder","toiletries","talcum powder","exact"),
 ("Moisturiser / Paste / Brush","toiletries","moisturiser|moisturizer","exact"),
 ("Eau-De-Cologne / Room Freshners","toiletries","room freshener|room freshner|cologne","exact"),
 ("Mineral Water","toiletries","mineral water","exact"),
 ("Buds","toiletries","ear bud|cotton bud","exact"),
 ("Barber Charges","toiletries","barber","exact"),
 ("Beauty Services","toiletries","beauty service","exact"),

 # --- baby / maternity ---
 ("Baby Charges","baby","baby charge","exact"),
 ("Baby Food","baby","baby food|lactogen|infant food","exact"),
 ("Baby Utilities Charges","baby","baby utilities","exact"),
 ("Baby Set","baby","baby set","exact"),
 ("Baby Bottles","baby","baby bottle|feeding bottle","exact"),
 ("Cradle Charges","baby","cradle","exact"),
 ("Vaccine Charges for Baby","baby","baby vaccine|vaccine charges for baby","exact"),

 # --- comms / guest ---
 ("Telephone Charges","guest","telephone charge","exact"),
 ("Email / Internet Charges","guest","internet charge|email charge|wifi","exact"),
 ("DVD, CD Charges","guest","dvd charge|cd charge","exact"),
 ("Guest Services","guest","guest service","exact"),
 ("Food Charges (Other than Patient's Diet)","guest","attendant food|guest food|visitor food","exact"),

 # --- equipment / take-home devices ---
 ("Walking Aids Charges","equipment","walking aid|walker charge","exact"),
 ("BiPAP Machine","equipment","bipap","exact"),
 ("Commode","equipment","commode","exact"),
 ("Oxygen Cylinder (usage outside hospital)","equipment","oxygen cylinder","review"),
 ("Oxygen Mask","equipment","oxygen mask","exact"),
 ("Spacer","equipment","spacer","exact"),
 ("SPO2 Probe","equipment","spo2 probe|spo2 sensor","exact"),
 ("Nebulizer Kit","equipment","nebulizer kit|nebuliser kit","exact"),
 ("Steam Inhaler","equipment","steam inhaler","exact"),
 ("Arm Sling","equipment","arm sling","exact"),
 ("Cervical Collar","equipment","cervical collar","exact"),
 ("Ambulance Collar","equipment","ambulance collar","exact"),
 ("Ambulance Equipment","equipment","ambulance equipment","exact"),
 ("Splint","equipment","splint","exact"),
 ("Knee Braces","equipment","knee brace","exact"),
 ("Knee/Shoulder Immobilizer","equipment","immobilizer|immobiliser","exact"),
 ("Diabetic Foot Wear","equipment","diabetic footwear|diabetic foot wear","exact"),
 ("Visco Belt Charges","equipment","visco belt","exact"),
 ("Cold Pack / Hot Pack","equipment","cold pack|hot pack","exact"),
 ("Hand Holder","equipment","hand holder","exact"),
 ("Any Kit With No Details Mentioned","consumable","kit","review"),
 # commonly deducted by insurers but NOT named in the published list - never auto-flag
 ("CSSD / Sterilisation Charges","consumable","cssd|sterilisation charge|sterilization charge","review"),
 ("ECG Electrodes / Leads","consumable","ecg lead|ecg electrode","review"),
 ("Dressing / Tegaderm film","consumable","tegaderm|transparent dressing","review"),

 # --- policy exclusions (treatment-level, not line items) ---
 ("Weight Control Programs / Supplies / Services","exclusion","weight control|obesity program","exact"),
 ("Spectacles / Contact Lenses / Hearing Aids","exclusion","spectacle|contact lens|hearing aid","exact"),
 ("Dental Treatment Not Requiring Hospitalisation","exclusion","dental treatment","exact"),
 ("Hormone Replacement Therapy","exclusion","hormone replacement","exact"),
 ("Home Visit Charges","exclusion","home visit","exact"),
 ("Infertility / Assisted Conception","exclusion","infertility|ivf|assisted conception","exact"),
 ("Obesity Treatment","exclusion","bariatric|obesity treatment","exact"),
 ("Corrective Surgery for Refractive Error","exclusion","lasik|refractive error","exact"),
 ("Donor Screening Charges","exclusion","donor screening","exact"),
 ("Hospitalisation for Evaluation / Diagnostic Purpose","exclusion","evaluation only|diagnostic admission","exact"),
 ("Aesthetic Treatment / Surgery","exclusion","aesthetic|cosmetic surgery","exact"),
 ("Stem Cell Implantation / Surgery","exclusion","stem cell","exact"),
]

with open("irdai_non_payables.csv","w",newline="",encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["item","category","match_keywords","confidence","source_document","effective_date"])
    for item, cat, kw, conf in ROWS:
        w.writerow([item, cat, kw, conf, SRC, EFF])

print(f"irdai_non_payables.csv  ->  {len(ROWS)} rows")
from collections import Counter
print(" by category:", dict(Counter(r[1] for r in ROWS)))
print(" by confidence:", dict(Counter(r[3] for r in ROWS)))
