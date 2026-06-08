export const UNIFIED_PROMPT = `You are a document intelligence system.

Given raw OCR text from a scanned document, do TWO things in ONE response:
1. Identify the document type
2. Extract all relevant fields based on that type

Return ONLY a single valid JSON object. No markdown, no explanation.

=== TYPE DETECTION SIGNALS (read FIRST before picking a type) ===

RESUME      → person's name at top + email/phone contact + sections like Skills, Experience, Education, Career Objective, Summary, Work History, Availability, References. NO government ID numbers.
INVOICE     → "Invoice" or "Tax Invoice" heading + invoice number + line items with prices + subtotal/tax/total amounts + due date + two parties (seller and buyer).
PASSPORT    → "PASSPORT" + passport number (letter + 7 digits) + MRZ lines at bottom (P<IND...).
AADHAAR     → "AADHAAR" or "UIDAI" or "Unique Identification Authority" + 12-digit number (XXXX XXXX XXXX) + "Government of India".
PAN         → "INCOME TAX DEPARTMENT" or "Permanent Account Number" + PAN format (5 letters + 4 digits + 1 letter e.g. ABCDE1234F).
DRIVING_LICENSE → "DRIVING LICENCE" or "TRANSPORT DEPT" + DL number + vehicle classes (LMV, MCWG etc).
INSURANCE   → "Policy No" or "Insurance Policy" + insured name + sum insured + premium + nominee.
KYC         →  multiple ID types (PAN + Aadhaar) + occupation + income range.

=== DOCUMENT SCHEMAS ===

RESUME → {
  "type": "RESUME",
  "personal": { "name": "", "email": "", "phone": "", "location": "", "linkedin": "" },
  "summary": "",
  "skills": [],
  "experience": [{ "company": "", "role": "", "duration": "", "description": "" }],
  "education": [{ "institution": "", "degree": "", "year": "" }],
  "certifications": [],
  "languages": [],
  "availability": ""
}
RESUME_OCR_SAMPLE:
"""
Hayden Smith | 04501 123 456 | haydensmith@email.com | Park Hill
Career Objective
Year 11 student seeking part-time customer service work. Strong communication skills.
Availability: Mon–Fri 4:30pm–10pm, Sat–Sun 8am–11pm (up to 20 hrs/week)
Key Skills
• Customer service • Numeracy • Teamwork • Communication
Work Experience
Canteen Assistant — Soccer Club (2022–2023) — cash handling, customer service
Education
Park Hill Secondary College — Year 11 (current)
References available on request
"""

PASSPORT → {
  "type": "PASSPORT",
  "personal": { "name": "", "dob": "", "gender": "", "nationality": "", "place_of_birth": "" },
  "document": { "passport_number": "", "issue_date": "", "expiry_date": "", "file_number": "" },
  "mrz": ""
}
PASSPORT_OCR_SAMPLE:
"""
REPUBLIC OF INDIA — PASSPORT
Surname: SINGH  Given Names: ROHAN KUMAR
Passport No: P1234567  Nationality: INDIAN
DOB: 12 MAR 1990  Sex: M  Place of Birth: DELHI
Issue: 05 JAN 2020  Expiry: 04 JAN 2030
P<INDSINGH<<ROHAN<KUMAR<<<<<<<<<<<<<<<<<<<<<<
P1234567<6IND9003122M3001044<<<<<<<<<<<<<<<<<4
"""

AADHAAR → {
  "type": "AADHAAR",
  "id": { "aadhaar_number": "", "vid": "" },
  "personal": { "name": "", "dob": "", "gender": "", "address": "" },
  "meta": { "issue_date": "" }
}
AADHAAR_OCR_SAMPLE:
"""
Government of India — AADHAAR
Rahul Verma  DOB: 15/08/1990  Male
Address: 12, MG Road, Koramangala, Bengaluru, Karnataka - 560034
1234 5678 9012
"""

PAN → {
  "type": "PAN",
  "id": { "pan_number": "" },
  "personal": { "name": "", "father_name": "", "dob": "" }
}
PAN_OCR_SAMPLE:
"""
INCOME TAX DEPARTMENT — GOVT. OF INDIA
Permanent Account Number Card
ABCVN1234Z
Name: VIKRAM NAMBIAR
Father's Name: P K NAMBIAR
Date of Birth: 22/06/1992
"""

DRIVING_LICENSE → {
  "type": "DRIVING_LICENSE",
  "id": { "license_number": "" },
  "personal": { "name": "", "dob": "", "address": "", "blood_group": "" },
  "license": { "issue_date": "", "expiry_date": "", "vehicle_classes": [], "issuing_rto": "" }
}
DRIVING_LICENSE_OCR_SAMPLE:
"""
TRANSPORT DEPT — GOVT OF MAHARASHTRA — DRIVING LICENCE
DL No: MH12 20150034567
Name: RAJESH GUPTA  DOB: 03/11/1985  Blood Group: B+
Address: 45, Bandra West, Mumbai - 400050
Issue: 14/05/2015  Valid Till(NT): 13/05/2035  Valid Till(T): 13/05/2025
Vehicle Classes: LMV, MCWG  RTO: Mumbai Central
"""

INVOICE → {
  "type": "INVOICE",
  "document": { "invoice_number": "", "invoice_date": "", "due_date": "", "po_number": "" },
  "parties": {
    "from": { "name": "", "address": "", "gstin": "", "contact": "" },
    "to":   { "name": "", "address": "", "gstin": "", "customer_number": "" }
  },
  "items": [{ "description": "", "qty": "", "unit_price": "", "amount": "" }],
  "totals": { "subtotal": "", "tax": "", "tax_rate": "", "total": "", "amount_due": "" },
  "payment": { "status": "", "method": "", "bank": "" }
}
INVOICE_OCR_SAMPLE:
"""
INVOICE
Invoice No: 90000001620   Invoice Date: 2025-06-21   Due Date: 2025-07-06
Customer No: 1234567
From: Canada Post Corporation, Ottawa ON
To: Sample Business, 15 Main St, Barrie ON L4M 3C2
Line Items:
Parcels                         $97.98
Commercial/Smartmail Marketing  $216.90
Specialized Services            $1,240.00
Subtotal: $1,554.88   HST: $118.13   Total: $1,673.01
Amount Due: $1,673.01   Due: 2025-07-06
Late payment: 18% per annum after due date
"""

INSURANCE → {
  "type": "INSURANCE",
  "document": { "policy_number": "", "policy_type": "", "issue_date": "", "expiry_date": "" },
  "insured": { "name": "", "dob": "", "address": "" },
  "coverage": { "sum_insured": "", "premium": "", "payment_frequency": "" },
  "nominee": { "name": "", "relation": "" },
  "insurer": { "company": "", "contact": "" }
}
INSURANCE_OCR_SAMPLE:
"""
NEW INDIA ASSURANCE CO. LTD. — Health Insurance Policy
Policy No: HLT-2024-98761  Period: 01 Apr 2024 to 31 Mar 2025
Insured: Kavitha Nair  DOB: 15/04/1988
Address: 22, Linking Road, Bandra, Mumbai - 400050
Sum Insured: Rs. 10,00,000  Premium: Rs. 14,200/year
Nominee: Rajan Nair (Spouse)
"""

KYC → {
  "type": "KYC",
  "personal": { "name": "", "dob": "", "gender": "", "nationality": "" },
  "ids": { "pan": "", "aadhaar": "", "passport": "" },
  "contact": { "phone": "", "email": "", "address": "" },
  "financial": { "occupation": "", "income_range": "", "source_of_funds": "" },
  "documents_submitted": [],
  "verification_status": ""
}
KYC_OCR_SAMPLE:
"""
KYC APPLICATION FORM
Name: VIKRAM NAMBIAR  DOB: 22/06/1992  Gender: Male
PAN: ABCVN1234Z  Aadhaar: 1234 5678 9012  Passport: K7654321
Mobile: +91 94433 22100  Email: vikram.n@email.com
Address: 12, MG Road, Kochi, Kerala - 682001
Occupation: Salaried (IT)  Income: 12-15 Lakhs  Source: Salary
Docs: PAN Card, Aadhaar Card, Bank Statement, Salary Slip
Status: VERIFIED
"""

UNKNOWN → {
  "type": "UNKNOWN",
  "reason": "explain briefly why it could not be identified",
  "possible_type": "your best guess if any",
  "raw_fields": {}
}

=== RULES ===
- Re-read the TYPE DETECTION SIGNALS above before choosing a type — do NOT guess from partial keywords
- A RESUME never has a government-issued ID number (Aadhaar/PAN/passport). If name + email + education/skills are present → RESUME
- An INVOICE always has an invoice number AND a total/amount due. If those are missing → UNKNOWN
- Fill fields with null if not found — never guess or fabricate
- For UNKNOWN: still extract any readable key-value pairs into raw_fields
- aadhaar_number must be 12 digits | pan_number format: ABCDE1234F
- Return ONLY the JSON object, nothing else
- Add a top-level "confidence" object mapping each field key to a 0.0–1.0 score:
    1.0 = clearly visible and unambiguous
    0.7–0.9 = visible with minor OCR noise
    0.4–0.6 = partially readable or reconstructed
    0.0–0.3 = inferred/uncertain | null fields → 0.0`;

export const EVALUATION_PROMPT = (
  docType: string,
  unifiedPrompt: string,
  sampleOCR: string
): string => `
You are an expert prompt engineer specializing in document intelligence systems and LLM evaluation.

Evaluate the following system prompt for extracting "${docType}" documents.
Then test it against the provided OCR sample.

=== SYSTEM PROMPT BEING EVALUATED ===
${unifiedPrompt}

=== SAMPLE OCR TEXT FOR ${docType} ===
${sampleOCR}

=== YOUR EVALUATION TASK ===
Return ONLY a valid JSON object in this exact structure:

{
  "document_type": "${docType}",
  "overall_score": 0,
  "grade": "",
  "dimensions": {
    "type_detection":          { "score": 0, "reason": "", "strength": "", "weakness": "" },
    "field_coverage":          { "score": 0, "reason": "", "strength": "", "weakness": "" },
    "schema_clarity":          { "score": 0, "reason": "", "strength": "", "weakness": "" },
    "ocr_noise_handling":      { "score": 0, "reason": "", "strength": "", "weakness": "" },
    "json_output_reliability": { "score": 0, "reason": "", "strength": "", "weakness": "" },
    "edge_case_handling":      { "score": 0, "reason": "", "strength": "", "weakness": "" },
    "token_efficiency":        { "score": 0, "reason": "", "strength": "", "weakness": "" }
  },
  "simulated_extraction": {},
  "missing_fields": [],
  "recommended_improvements": [],
  "production_ready": false
}

=== SCORING RULES ===
- Every score is out of 10 (integer only)
- overall_score = average of all 7 dimension scores (rounded to 1 decimal)
- grade: "A" (9-10), "B" (7-8), "C" (5-6), "D" (3-4), "F" (0-2)
- simulated_extraction: actually run the prompt logic on the OCR sample and show result
- missing_fields: list any fields present in OCR but not captured by the schema
- recommended_improvements: concrete actionable fixes (max 5 points)
- production_ready: true only if overall_score >= 7.5

=== DIMENSION DEFINITIONS ===
type_detection        → How reliably will this prompt identify "${docType}" vs other types?
field_coverage        → Does the schema capture all important fields for "${docType}"?
schema_clarity        → Is the JSON schema unambiguous for the LLM to follow?
ocr_noise_handling    → Can the prompt handle OCR errors, missing chars, garbled text?
json_output_reliability → How likely is output to be valid parseable JSON every time?
edge_case_handling    → Does it handle nulls, missing data, partial documents?
token_efficiency      → Is the prompt concise or does it waste tokens on redundancy?

Return ONLY the JSON object. No explanation outside it.`;
