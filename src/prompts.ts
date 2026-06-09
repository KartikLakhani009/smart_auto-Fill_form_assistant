export const UNIFIED_PROMPT = `You are a document parser. Read OCR text, identify document type, extract fields.
Output ONLY valid JSON matching the detected type schema. No explanation.
 
<Detection>
Check signals IN ORDER. First full match wins.
 
<AADHAAR>MUST HAVE ALL: ("Government of India" OR "UIDAI") + name + DOB dd/mm/yyyy + gender + 12-digit XXXX XXXX XXXX</AADHAAR>
<PAN>MUST HAVE ALL: "INCOME TAX DEPARTMENT" + "GOVT. OF INDIA" + name + father_name + dob dd/mm/yyyy + PAN format AAAAA9999A</PAN>
<PASSPORT>MUST HAVE ALL: "REPUBLIC OF" + "PASSPORT" + passport_no(1letter+7digits) + surname + DOB + MRZ lines with "<<"</PASSPORT>
<DRIVING_LICENSE>MUST HAVE ALL: ("Union of India" OR "DRIVING LICENCE") + DL No(2letters+digits) + DOI(issue date) + DOL/expiry</DRIVING_LICENSE> + name
<INSURANCE>MUST HAVE ALL: "Policy No" + insured_name + expiry_date</INSURANCE>
<INVOICE>MUST HAVE ALL: company_name + invoice_no + min 2 line_items with price + total_amount + date</INVOICE>
<KYC>MUST HAVE: ("KYC" OR "Know Your Customer" in title) OR (occupation + income_range + source_of_funds + any ID number)</KYC>
<RESUME>MUST HAVE ALL: person_name at top + (email OR phone) + (Skills OR Experience OR Education section). NO govt ID numbers.</RESUME>
<UNKNOWN>Fewer than 2 signals match any type above.</UNKNOWN>
</Detection>
 
<Schemas>
<AADHAAR>{"type":"AADHAAR","id":{"aadhaar_number":"","vid":""},"personal":{"name":"","dob":"","gender":"","address":""},"meta":{"issue_date":""}}</AADHAAR>
<PAN>{"type":"PAN","id":{"pan_number":""},"personal":{"name":"","father_name":"","dob":""}}</PAN>
<PASSPORT>{"type":"PASSPORT","personal":{"name":"","dob":"","gender":"","nationality":"","place_of_birth":""},"document":{"passport_number":"","issue_date":"","expiry_date":"","file_number":""},"mrz":""}</PASSPORT>
<DRIVING_LICENSE>{"type":"DRIVING_LICENSE","id":{"license_number":""},"personal":{"name":"","dob":"","address":"","blood_group":""},"license":{"issue_date":"","expiry_date":"","vehicle_classes":[],"issuing_rto":""}}</DRIVING_LICENSE>
<INSURANCE>{"type":"INSURANCE","document":{"policy_number":"","policy_type":"","issue_date":"","expiry_date":""},"insured":{"name":"","dob":"","address":""},"coverage":{"sum_insured":"","premium":"","payment_frequency":""},"nominee":{"name":"","relation":""},"insurer":{"company":"","contact":""}}</INSURANCE>
<INVOICE>{"type":"INVOICE","document":{"invoice_number":"","invoice_date":"","due_date":"","po_number":""},"parties":{"from":{"name":"","address":"","gstin":""},"to":{"name":"","address":"","gstin":"","customer_number":""}},"items":[{"description":"","qty":"","unit_price":"","amount":""}],"totals":{"subtotal":"","tax":"","tax_rate":"","total":"","amount_due":""},"payment":{"status":"","method":"","bank":""}}</INVOICE>
<KYC>{"type":"KYC","personal":{"name":"","dob":"","gender":"","nationality":""},"ids":{"pan":"","aadhaar":"","passport":""},"contact":{"phone":"","email":"","address":""},"financial":{"occupation":"","income_range":"","source_of_funds":""},"documents_submitted":[],"verification_status":""}</KYC>
<RESUME>{"type":"RESUME","personal":{"name":"","email":"","phone":"","location":"","linkedin":""},"summary":"","skills":[],"experience":[{"company":"","role":"","duration":"","description":""}],"education":[{"institution":"","degree":"","year":""}],"certifications":[],"languages":[],"availability":""}</RESUME>
<UNKNOWN>{"type":"UNKNOWN","reason":"","possible_type":"","raw_fields":{}}</UNKNOWN>
</Schemas>
 
<Rules>
- null for any missing field, never fabricate
- aadhaar_number: exactly 12 digits | pan_number: AAAAA9999A pattern
- UNKNOWN: put any readable key-value pairs into raw_fields
- Add top-level "confidence":{field_name:0.0-1.0} for every extracted field
  1.0=clearly visible | 0.7=minor OCR noise | 0.4=partial | 0.0=null/missing
- OCR noise: ignore garbled tokens (random symbols, gibberish like "HegHe", "vgs}", "TT TT SEER"); extract meaning only from recognizable words, numbers, dates, and known field patterns
</Rules>`;

export const OCR_SAMPLES = `
<Samples>
<AADHAAR>Government of India AADHAAR
Rahul Verma DOB:15/08/1990 Male
12,MG Road,Bengaluru 560034
1234 5678 9012</AADHAAR>
 
<PAN>INCOME TAX DEPARTMENT GOVT.OF INDIA
VIKRAM NAMBIAR
P K NAMBIAR
22/06/1992
ABCVN1234Z</PAN>
 
<PASSPORT>REPUBLIC OF INDIA PASSPORT
Surname:SINGH GivenNames:ROHAN KUMAR
PassportNo:P1234567 DOB:12MAR1990 Sex:M
P<INDSINGH<<ROHAN<KUMAR<<<<<<<<<<<<<<<
P1234567<6IND9003122M3001044<<<<<<<<<4</PASSPORT>
 
<DRIVING_LICENSE>TRANSPORT DEPT GOVT MAHARASHTRA DRIVING LICENCE
DL No:MH12 20150034567 Name:RAJESH GUPTA DOB:03/11/1985
DOI:14/05/2015 DOL:13/05/2035 Classes:LMV,MCWG RTO:Mumbai Central</DRIVING_LICENSE>
 
<INVOICE>TAX INVOICE TechSoft Solutions Pvt Ltd GSTIN:27AABCT1234R1Z5
Inv:INV-2024-001 Date:01/06/2024 Due:15/06/2024
Web Dev x1 85000 | UI/UX x1 35000 | Server x1 15000
Subtotal:135000 GST:24300 Total:159300 PAID</INVOICE>
 
<INSURANCE>NEW INDIA ASSURANCE Health Insurance
Policy No:HLT-2024-98761 Period:01Apr2024-31Mar2025
Insured:Kavitha Nair DOB:15/04/1988
SumInsured:1000000 Premium:14200/yr Nominee:Rajan Nair(Spouse)</INSURANCE>
 
<KYC>KYC APPLICATION FORM
Name:VIKRAM NAMBIAR DOB:22/06/1992 Gender:Male
PAN:ABCVN1234Z Aadhaar:1234 5678 9012
Occupation:Salaried Income:12-15Lakhs Source:Salary Status:VERIFIED</KYC>
 
<RESUME>Hayden Smith 04501123456 haydensmith@email.com
Career Objective: seeking part-time work
Skills: Customer service, Teamwork
Work Experience: Canteen Assistant 2022-2023
Education: Park Hill Secondary College Year 11</RESUME>
</Samples>`;

// ─── Gemini evaluation: rich 7-dimension scoring of actual extraction output ──

export const EVALUATION_PROMPT_GEMINI = (
  docType: string,
  ocrText: string,
  extractedJson: string,
): string => `You are a document extraction quality evaluator.

Given the document type, raw OCR text, and the extracted JSON produced by an AI model, score how well the extraction performed.

=== DOCUMENT TYPE ===
${docType}

=== RAW OCR TEXT ===
${ocrText}

=== EXTRACTED JSON (model output) ===
${extractedJson}

=== SCORING RULES ===
- Every dimension score: INTEGER 0–10 (not 0.0–1.0, not fractions)
- overall_score = arithmetic mean of all 7 dimension scores, rounded to 1 decimal (e.g. if scores are 8,7,9,6,8,7,8 → 7.6)
- grade: A=9–10 | B=7–8 | C=5–6 | D=3–4 | F=0–2
- missing_fields: field names clearly readable in OCR text but null/absent in the extracted JSON
- recommended_improvements: max 5 concrete, actionable fixes (short strings)
- production_ready: true only if overall_score >= 7.5

=== DIMENSION DEFINITIONS ===
type_detection         → Was "${docType}" the correct type? Check OCR for document type markers. 10=correct, 0=wrong.
field_coverage         → Fraction of OCR-visible fields present in extracted JSON. 10=all fields found, 0=none.
value_accuracy         → Do extracted values exactly match OCR text? 10=all match, 5=some wrong, 0=fabricated.
ocr_noise_handling     → Were OCR artifacts (swapped chars, merged words, gibberish) handled correctly? 10=all fixed.
json_output_reliability → Is the JSON valid, well-formed, schema-compliant? 10=perfect structure.
completeness           → Are critical fields (name/date/id/contact) populated (not null/empty)? 10=all filled.
confidence_calibration → Are per-field confidence scores calibrated to actual OCR clarity? 10=perfectly calibrated.

Return ONLY the JSON object. No explanation outside it.`;

// ─── Local evaluation: compact XML-tagged prompt for small models ─────────────
// Only scores 4 meaningful dimensions; remaining 3 get fixed defaults to keep
// context short and JSON output reliable on small models (phi3, mistral, gemma).

export const EVALUATION_PROMPT_LOCAL = (
  docType: string,
  ocrText: string,
  extractedJson: string,
): string => `Score this document extraction. Return ONLY valid JSON.

<DocType>${docType}</DocType>

<OCR>
${ocrText.slice(0, 2000)}
</OCR>

<Extracted>
${extractedJson}
</Extracted>

<Rules>
IMPORTANT: overall_score and every dimension score use scale 0 to 10 — NOT 0.0 to 1.0. Example: a score of 5 out of 10 is written as 5, not 0.5.

type_detection: 10 if extracted.type matches DocType exactly, 0 if wrong type.
  reason: explain match/mismatch. strength: what was correct. weakness: what was wrong.

field_coverage: count non-null fields in Extracted, divide by total expected fields, multiply by 10, round to integer.
  reason: state count found vs expected. strength: which key fields found. weakness: which key fields missing.

value_accuracy: compare each extracted value to OCR text. 10=all match, 5=half match, 0=fabricated.
  reason: list mismatches if any. strength: values that match exactly. weakness: values that are wrong or fabricated.

completeness: check name/date/id/email/address fields. 10=all filled, 0=all null.
  reason: list what is null. strength: filled fields. weakness: null fields.

overall_score: (type_detection + field_coverage + value_accuracy + completeness) / 4, rounded to 1 decimal.
  EXAMPLE: scores 8, 6, 7, 5 → overall_score = 6.5 (NOT 0.65)

grade: A=9-10 | B=7-8 | C=5-6 | D=3-4 | F=0-2
production_ready: true if overall_score >= 7.5
missing_fields: array of field names visible in OCR but null in Extracted (empty array if none)
recommended_improvements: array of max 3 short fix strings (empty array if none)
</Rules>

Return JSON with this exact structure:
{"document_type":"${docType}","overall_score":0,"grade":"F","dimensions":{"type_detection":{"score":0,"reason":"","strength":"","weakness":""},"field_coverage":{"score":0,"reason":"","strength":"","weakness":""},"value_accuracy":{"score":0,"reason":"","strength":"","weakness":""},"completeness":{"score":0,"reason":"","strength":"","weakness":""}},"missing_fields":[],"recommended_improvements":[],"production_ready":false}`;