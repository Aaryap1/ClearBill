"""
Synthetic hospital-bill corpus — specification for 10 fictional bills.

Everything here is invented. No real patient, hospital, GSTIN or bill.
Programme brief allows synthetic data ("You can use sample synthetic Data
for your idea").

Each bill is a dict:
  id, header, sections[ {name, lines[ {item, unit, qty, rate} ]} ], defects[]

Amounts are computed (qty * rate), never hand-typed, so the ground truth is
exact. Defects are applied by generate.py AFTER the clean bill is built, and
recorded in truth/<id>.json so a checker can be scored against them.

Defect vocabulary
  subtotal_mismatch:<SECTION>:<delta>   printed section total = sum(lines)+delta
  duplicate:<SECTION>:<line_index>      that line is printed a second time
  missing_field:<header_key>            field is blank on the bill
  missing_unit_column                   the bill has no Unit column at all

6 bills carry >=1 defect (03,04,06,07,08,10). 4 are clean (01,02,05,09).
"""

HOSPITALS = {
    "SYN-01": ("Aravind Multispecialty Hospital", "14 MG Road, Pune 411001", "27AAACA1111Q1ZP", "020-24001100", "MH/HOSP/2018/4471"),
    "SYN-02": ("Sunrise Institute of Medical Sciences", "Plot 9, Sector 21, Navi Mumbai 400706", "27AABCS2222R1ZG", "022-27801234", "MH/HOSP/2016/2210"),
    "SYN-03": ("Green Valley Hospital & Research Centre", "Ring Road, Nagpur 440015", "27AAECG3333M1Z8", "0712-2560091", "MH/HOSP/2019/8842"),
    "SYN-04": ("City Care Superspeciality Hospital", "Station Road, Nashik 422001", "27AADCC4444K1ZR", "0253-2311220", "MH/HOSP/2017/6033"),
    "SYN-05": ("Lakeview Medical Trust Hospital", "Boat Club Road, Pune 411001", "27AAATL5555J1ZW", "020-26130500", "MH/HOSP/2015/1198"),
    "SYN-06": ("Sahyadri Speciality Hospital", "Karve Nagar, Pune 411052", "27AAJCS6666H1ZK", "020-40151000", "MH/HOSP/2020/9910"),
    "SYN-07": ("Matoshree General Hospital", "Old Pune-Mumbai Highway, Pimpri 411018", "27AAQCM7777G1ZB", "020-27421515", "MH/HOSP/2014/0771"),
    "SYN-08": ("Orchid Women's & Children's Hospital", "FC Road, Pune 411004", "27AAPCO8888F1ZD", "020-25530404", "MH/HOSP/2018/3355"),
    "SYN-09": ("Deccan Heart Institute", "JM Road, Pune 411005", "27AAECD9999E1ZM", "020-25670707", "MH/HOSP/2013/0442"),
    "SYN-10": ("Nirmal Nursing Home", "Gandhi Chowk, Kolhapur 416001", "27AAGFN1010D1ZT", "0231-2650321", "MH/HOSP/2012/0091"),
}

# procedure archetype -> which sections appear and how many lines from each pool
ARCHETYPES = {
    "SYN-01": ("Laparoscopic appendectomy",  {"REGISTRATION":1, "ROOM CHARGES":1, "CONSULTATION":2, "INVESTIGATIONS":4, "OT / PROCEDURE":4, "PHARMACY":6, "CONSUMABLES":5}),
    "SYN-02": ("Cataract surgery (day care)", {"REGISTRATION":1, "CONSULTATION":2, "INVESTIGATIONS":3, "OT / PROCEDURE":5, "PHARMACY":4, "CONSUMABLES":4}),
    "SYN-03": ("Coronary angioplasty (1 stent)", {"REGISTRATION":1, "ROOM CHARGES":2, "CONSULTATION":3, "INVESTIGATIONS":6, "OT / PROCEDURE":5, "PHARMACY":7, "CONSUMABLES":7, "MISCELLANEOUS":2}),
    "SYN-04": ("Normal vaginal delivery",     {"REGISTRATION":1, "ROOM CHARGES":2, "CONSULTATION":2, "INVESTIGATIONS":4, "OT / PROCEDURE":3, "PHARMACY":6, "CONSUMABLES":5, "MISCELLANEOUS":1}),
    "SYN-05": ("Haemodialysis (single session)", {"REGISTRATION":1, "CONSULTATION":1, "INVESTIGATIONS":4, "OT / PROCEDURE":2, "PHARMACY":5, "CONSUMABLES":6}),
    "SYN-06": ("Chemotherapy cycle",          {"REGISTRATION":1, "ROOM CHARGES":1, "CONSULTATION":2, "INVESTIGATIONS":5, "PHARMACY":9, "CONSUMABLES":6, "MISCELLANEOUS":2}),
    "SYN-07": ("Knee arthroscopy",            {"REGISTRATION":1, "ROOM CHARGES":2, "CONSULTATION":2, "INVESTIGATIONS":4, "OT / PROCEDURE":5, "PHARMACY":6, "CONSUMABLES":6}),
    "SYN-08": ("Inguinal hernia repair (mesh)", {"REGISTRATION":1, "ROOM CHARGES":2, "CONSULTATION":2, "INVESTIGATIONS":4, "OT / PROCEDURE":4, "PHARMACY":5, "CONSUMABLES":5}),
    "SYN-09": ("Pneumonia — medical admission", {"REGISTRATION":1, "ROOM CHARGES":3, "CONSULTATION":3, "INVESTIGATIONS":7, "PHARMACY":9, "CONSUMABLES":5, "MISCELLANEOUS":1}),
    "SYN-10": ("Ureteroscopy for renal calculus", {"REGISTRATION":1, "ROOM CHARGES":2, "CONSULTATION":2, "INVESTIGATIONS":5, "OT / PROCEDURE":4, "PHARMACY":6, "CONSUMABLES":5}),
}

PATIENTS = {
    "SYN-01": ("Rohan Deshpande",   34, "M", "IP2600041", "12-3456-7890-1001", "single", 1),
    "SYN-02": ("Kamala Iyer",       61, "F", "IP2600189", "12-3456-7890-1002", "day-care", 0),
    "SYN-03": ("Suresh Wagh",       57, "M", "IP2600233", "12-3456-7890-1003", "twin-sharing", 2),
    "SYN-04": ("Priya Salunke",     28, "F", "IP2600310", "12-3456-7890-1004", "twin-sharing", 2),
    "SYN-05": ("Abdul Karim",       49, "M", "IP2600377", "12-3456-7890-1005", "day-care", 0),
    "SYN-06": ("Meena Kulkarni",    52, "F", "IP2600402", "12-3456-7890-1006", "single", 1),
    "SYN-07": ("Vikram Patil",      41, "M", "IP2600455", "12-3456-7890-1007", "twin-sharing", 2),
    "SYN-08": ("Ganesh Rane",       45, "M", "IP2600491", "12-3456-7890-1008", "twin-sharing", 2),
    "SYN-09": ("Lata Bhosale",      66, "F", "IP2600530", "12-3456-7890-1009", "single", 3),
    "SYN-10": ("Imran Shaikh",      38, "M", "IP2600588", "12-3456-7890-1010", "twin-sharing", 2),
}

# admission window: (admit "DD/MM/YYYY HH:MM", discharge)
STAYS = {
    "SYN-01": ("31/05/2026 08:10", "01/06/2026 18:30"),
    "SYN-02": ("12/04/2026 07:30", "12/04/2026 15:45"),
    "SYN-03": ("03/03/2026 22:05", "06/03/2026 11:20"),
    "SYN-04": ("18/06/2026 02:40", "20/06/2026 12:00"),
    "SYN-05": ("09/05/2026 09:00", "09/05/2026 14:10"),
    "SYN-06": ("21/02/2026 09:15", "22/02/2026 17:00"),
    "SYN-07": ("14/07/2026 06:50", "16/07/2026 10:30"),
    "SYN-08": ("27/01/2026 07:15", "29/01/2026 09:40"),
    "SYN-09": ("05/08/2026 19:20", "09/08/2026 13:15"),
    "SYN-10": ("11/06/2026 05:30", "13/06/2026 16:20"),
}

# item pools: section -> list of (item, unit, rate)
POOLS = {
    "REGISTRATION": [
        ("ADMISSION SERVICES", "nos", 350.0),
        ("REGISTRATION CHARGES", "nos", 300.0),
        ("MEDICAL RECORDS CHARGES", "nos", 250.0),
    ],
    "ROOM CHARGES": [
        ("SINGLE ROOM - AC", "day", 6000.0),
        ("TWIN SHARING ROOM", "day", 3500.0),
        ("ICU BED CHARGES", "day", 9500.0),
        ("HDU BED CHARGES", "day", 7000.0),
        ("NURSING CHARGES", "day", 800.0),
        ("RMO / DUTY DOCTOR CHARGES", "day", 600.0),
    ],
    "CONSULTATION": [
        ("IP CONSULTATION - PHYSICIAN", "visit", 900.0),
        ("IP CONSULTATION - SURGEON", "visit", 1200.0),
        ("IP CONSULTATION - ANAESTHETIST", "visit", 1000.0),
        ("IP CONSULTATION - CARDIOLOGIST", "visit", 1300.0),
        ("IP CONSULTATION - DIETITIAN", "visit", 400.0),
        ("IP CONSULTATION - PHYSIOTHERAPY", "visit", 500.0),
    ],
    "INVESTIGATIONS": [
        ("COMPLETE BLOOD COUNT (CBC)", "test", 380.0),
        ("SERUM ELECTROLYTES", "test", 520.0),
        ("LIVER FUNCTION TEST", "test", 780.0),
        ("KIDNEY FUNCTION TEST", "test", 720.0),
        ("RANDOM BLOOD SUGAR", "test", 120.0),
        ("CHEST X-RAY PA VIEW", "test", 450.0),
        ("ECG", "test", 300.0),
        ("2D ECHO", "test", 2200.0),
        ("USG ABDOMEN & PELVIS", "test", 1600.0),
        ("HISTOPATHOLOGY - SMALL SPECIMEN", "test", 1900.0),
        ("URINE ROUTINE & MICROSCOPY", "test", 200.0),
        ("HbA1c", "test", 600.0),
        ("COAGULATION PROFILE (PT/INR)", "test", 650.0),
        ("CRP QUANTITATIVE", "test", 700.0),
    ],
    "OT / PROCEDURE": [
        ("OPERATION THEATRE CHARGES", "hour", 4500.0),
        ("SURGEON'S FEE", "nos", 15000.0),
        ("ANAESTHESIA CHARGES", "nos", 6000.0),
        ("ANAESTHESIA GASES & DRUGS", "nos", 1800.0),
        ("OT CONSUMABLES PACKAGE", "nos", 3200.0),
        ("C-ARM / IMAGE INTENSIFIER", "nos", 2500.0),
        ("DIALYSIS PROCEDURE CHARGES", "session", 2800.0),
        ("DIALYSER (SINGLE USE)", "nos", 1200.0),
        ("CHEMOTHERAPY ADMINISTRATION", "session", 2400.0),
        ("PHYSIOTHERAPY SESSION", "session", 450.0),
    ],
    "PHARMACY": [
        ("INJ CEFTRIAXONE 1GM", "vial", 62.0),
        ("INJ PANTOPRAZOLE 40MG", "vial", 38.0),
        ("INJ ONDANSETRON 2MG/ML", "amp", 14.0),
        ("INJ TRAMADOL 50MG", "amp", 22.0),
        ("TAB PARACETAMOL 650MG", "tab", 3.5),
        ("TAB PANTOPRAZOLE 40MG", "tab", 6.0),
        ("INJ AMIKACIN 500MG", "vial", 48.0),
        ("IV FLUID RL 500ML", "bottle", 45.0),
        ("IV FLUID NS 500ML", "bottle", 42.0),
        ("INJ ENOXAPARIN 40MG", "syringe", 260.0),
        ("TAB DOLO 650", "tab", 3.0),
        ("INJ HYDROCORTISONE 100MG", "vial", 35.0),
        ("SYP POTASSIUM CHLORIDE", "bottle", 88.0),
        ("INJ PIPERACILLIN-TAZOBACTAM 4.5G", "vial", 310.0),
        ("INSULIN HUMAN REGULAR 40IU", "vial", 140.0),
        ("INJ FUROSEMIDE 20MG", "amp", 10.0),
    ],
    "CONSUMABLES": [
        ("IV CANNULA 20G", "nos", 55.0),
        ("IV SET", "nos", 38.0),
        ("DISPOSABLE SYRINGE 5ML", "nos", 6.0),
        ("DISPOSABLE SYRINGE 10ML", "nos", 9.0),
        ("SURGICAL GLOVES STERILE 7.0", "pair", 26.0),
        ("EXAMINATION GLOVES (NITRILE)", "nos", 8.0),
        ("COTTON ROLL 500G", "nos", 120.0),
        ("GAUZE SWABS STERILE", "pkt", 45.0),
        ("TRANSPARENT DRESSING (TEGADERM)", "nos", 94.0),
        ("URINE BAG", "nos", 60.0),
        ("FOLEYS CATHETER 16FR", "nos", 110.0),
        ("SPINAL NEEDLE 25G", "nos", 180.0),
        ("SUTURE - POLYGLACTIN 2-0", "nos", 240.0),
        ("ECG ELECTRODES", "nos", 15.0),
        ("FACE MASK 3-PLY", "nos", 4.0),
        ("PROPOFOL 20ML", "vial", 95.0),
    ],
    "MISCELLANEOUS": [
        ("BIOMEDICAL WASTE CHARGES", "nos", 150.0),
        ("DIET CHARGES", "day", 300.0),
        ("ATTENDANT PASS", "nos", 100.0),
        ("AMBULANCE CHARGES", "nos", 1200.0),
        ("DOCUMENTATION / ADMIN CHARGES", "nos", 200.0),
    ],
}

# quantity strategy per section (deterministic; los = length of stay in days, min 1)
def qty_for(section, idx, los):
    los = max(los, 1)
    if section == "REGISTRATION":   return 1
    if section == "ROOM CHARGES":   return los if idx == 0 else los  # room + nursing both per day
    if section == "CONSULTATION":   return 1 + (idx % 2) + (los // 3)
    if section == "INVESTIGATIONS": return 1 if idx % 3 else 2
    if section == "OT / PROCEDURE": return 1 if section != "OT / PROCEDURE" or idx else 2
    if section == "PHARMACY":       return (idx % 4) + 1 + los
    if section == "CONSUMABLES":    return (idx % 3) + 1 + (los // 2)
    if section == "MISCELLANEOUS":  return los if "day" else 1
    return 1

# which bills get which defects
DEFECTS = {
    "SYN-03": ["subtotal_mismatch:PHARMACY:10"],
    "SYN-04": ["duplicate:CONSULTATION:0"],
    "SYN-06": ["missing_field:hospital_gstin", "missing_unit_column"],
    "SYN-07": ["subtotal_mismatch:OT / PROCEDURE:-150", "missing_field:bill_number"],
    "SYN-08": ["duplicate:INVESTIGATIONS:1", "missing_field:hospital_gstin"],
    "SYN-10": ["missing_field:bill_number", "missing_unit_column", "missing_field:hospital_gstin"],
}

DISCHARGE_MEDS_RETURN = {"SYN-03", "SYN-09"}  # these bills include a negative pharmacy-return line
