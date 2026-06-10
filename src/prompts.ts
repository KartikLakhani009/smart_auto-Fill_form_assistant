// ─── Extraction prompt building blocks ────────────────────────────────────────
// Techniques applied: role priming, stepwise task decomposition, ordered
// signal-based classification, exact output schemas, anchored confidence
// rubric, negative instructions (anti-patterns), few-shot input→output pairs,
// and a pre-output self-check. Two variants share these blocks:
//   UNIFIED_PROMPT       — full version for Gemini / Groq (70B-class models)
//   UNIFIED_PROMPT_LOCAL — compact version for small local models (phi3 etc.)

const DETECTION_BLOCK = `<Detection>
Check signals IN ORDER. First type that matches wins.
OCR often LOSES headers and titles — a strong keyword is sufficient but NOT required when enough field signals are present.

<AADHAAR>STRONG: "Government of India" / "UIDAI" / "Aadhaar". OR ≥3 of: name + DOB dd/mm/yyyy + gender + 12-digit XXXX XXXX XXXX. The grouped 12-digit number is the strongest single signal.</AADHAAR>
<PAN>STRONG: "INCOME TAX DEPARTMENT" / "Permanent Account Number". OR ≥2 of: PAN format AAAAA9999A + two consecutive person names (holder then father) + dob dd/mm/yyyy.</PAN>
<PASSPORT>STRONG: "REPUBLIC OF" + "PASSPORT", OR any MRZ line (starts "P<" or contains "<<"). Plus ≥2 of: surname/given names + DOB + issue/expiry dates + place of birth.
PASSPORT NUMBER (Indian): printed top-right, on or just after the "REPUBLIC OF INDIA" line — OCR renders it like "...INDIAN 20000000". Take that token as document.passport_number even when it is OCR-noisy or does not fit the usual 1-letter+7-digit shape. Do NOT read the passport number from the MRZ digits.</PASSPORT>
<DRIVING_LICENSE>STRONG: "DRIVING LICENCE" / "Union of India". Plus: DL No(2letters+digits) + name + (DOI issue date OR DOL/expiry).</DRIVING_LICENSE>
<INSURANCE>MUST HAVE ALL: "Policy No" + insured_name + expiry_date</INSURANCE>
<INVOICE>MUST HAVE: ("Invoice" OR invoice_no) + ≥1 line_item with price + total_amount + date</INVOICE>
<KYC>MUST HAVE: ("KYC" OR "Know Your Customer" in title) OR (occupation + income_range + source_of_funds + any ID number)</KYC>
<RESUME>MUST HAVE ALL: person_name at top + (email OR phone) + (Skills OR Experience OR Education section). NO govt ID numbers.</RESUME>
<UNKNOWN>Only when fewer than 2 signals match ANY type above. Before choosing UNKNOWN, re-scan for ID patterns (12-digit grouped, AAAAA9999A, MRZ "<<") — they outrank lost headers.</UNKNOWN>
</Detection>`;

const SCHEMAS_BLOCK = `<Schemas>
A key written with "?" (e.g. "address"?) is OPTIONAL — it is not printed on every document. A key WITHOUT "?" is a core field expected on that document type. EITHER WAY the output rule is the same: include the value when it is readable in the OCR, otherwise set the key to null — never omit a key, never use "". Every schema key (optional or not) also gets a confidence score. The "?" only signals that an absent optional field is normal, not a defect.
<AADHAAR>{"type":"AADHAAR","id":{"aadhaar_number":""},"personal":{"name":"","dob":"","gender":"","address"?:""}}</AADHAAR>
<PAN>{"type":"PAN","id":{"pan_number":""},"personal":{"name":"","father_name":"","dob":""}}</PAN>
<PASSPORT>{"type":"PASSPORT","personal":{"name":"","dob":"","gender":"","nationality":"","place_of_birth":""},"document":{"passport_number":"","issue_date":"","expiry_date":"","file_number"?:""},"mrz":""}</PASSPORT>
<DRIVING_LICENSE>{"type":"DRIVING_LICENSE","id":{"license_number":""},"personal":{"name":"","dob":"","address":"","blood_group":""},"license":{"issue_date":"","expiry_date":"","vehicle_classes":[],"issuing_rto":""}}</DRIVING_LICENSE>
<INSURANCE>{"type":"INSURANCE","document":{"policy_number":"","policy_type"?:"","issue_date":"","expiry_date":""},"insured":{"name":"","dob":"","address":""},"coverage":{"sum_insured":"","premium":"","payment_frequency"?:""},"nominee"?:{"name":"","relation":""},"insurer":{"company":"","contact":""}}</INSURANCE>
<INVOICE>{"type":"INVOICE","document":{"invoice_number":"","invoice_date":"","due_date":"","po_number"?:""},"parties":{"from":{"name":"","address"?:"","gstin"?:""},"to":{"name":"","address"?:"","gstin"?:"","customer_number"?:""}},"items":[{"description":"","qty":"","unit_price":"","amount":""}],"totals":{"subtotal":"","tax":"","tax_rate":"","total":"","amount_due":""},"payment":{"status":"","method":"","bank":""}}</INVOICE>
<KYC>{"type":"KYC","personal":{"name":"","dob":"","gender":"","nationality"?:""},"ids":{"pan"?:"","aadhaar"?:"","passport"?:""},"contact"?:{"phone":"","email":"","address":""},"financial"?:{"occupation":"","income_range":"","source_of_funds":""},"documents_submitted":[],"verification_status":""}</KYC>
<RESUME>{"type":"RESUME","personal":{"name":"","email":"","phone":"","location"?:"","linkedin"?:""},"summary"?:"","skills"?:[],"experience"?:[{"company":"","role":"","duration":"","description":""}],"education"?:[{"institution":"","degree":"","year":""}],"certifications"?:[],"languages"?:[],"availability"?:[]}</RESUME>
<UNKNOWN>{"type":"UNKNOWN","reason":"","possible_type":"","raw_fields":{}}</UNKNOWN>
</Schemas>`;

const CONFIDENCE_RUBRIC = `<ConfidenceRubric>
Add top-level "confidence":{field_name:score} covering EVERY field of the chosen schema:
1.0 = value clearly readable, copied exactly
0.7 = minor OCR noise fixed (1-2 character corrections like 0↔O, 1↔I/l, 5↔S, 8↔B)
0.4 = partially readable or inferred from a fragment
0.0 = not visible in OCR → field value MUST be null
</ConfidenceRubric>`;

const NEVER_BLOCK = `<Never>
- NEVER fabricate plausible values (no invented names, dates, numbers, addresses)
- NEVER use empty string "" for a missing value — always JSON null
- NEVER copy gibberish tokens (e.g. "HegHe", "vgs}", "TT TT SEER", "Y Lid {") into field values
- NEVER reformat dates — keep them exactly as written in the OCR
- NEVER add fields that are not in the chosen schema, and NEVER move a field to a different nesting level (e.g. "gender" belongs inside "personal", not at top level)
- NEVER put subtotal/tax/total inside the "items" array — each items entry is one purchased line item with description/qty/unit_price/amount; totals go in "totals"
- NEVER output markdown fences, comments, or any text outside the JSON object
</Never>`;

// Few-shot pairs built from REAL Tesseract output of the project's test files
// (batch_results.json) — they show actual noise patterns and the exact failure
// modes observed with weak models: lost headers, gibberish copied into fields,
// empty strings instead of null, missed ID numbers, premature UNKNOWN.
// Outputs are gold answers and must stay schema-exact — update if schemas change.
const FEW_SHOT_BLOCK = `<Examples>
<Example1>
<Input>
Sriram Mamundi
Umps prer / DOB : 11/04/1992
oir | MALE SIS he >
BRET
8416 1590 3267  EEHEEl
a5 - ar srrent wef seaflar gdlesryod
</Input>
<Output>{"type":"AADHAAR","id":{"aadhaar_number":"841615903267"},"personal":{"name":"Sriram Mamundi","dob":"11/04/1992","gender":"Male","address":null},"confidence":{"aadhaar_number":1.0,"name":1.0,"dob":1.0,"gender":0.7,"address":0.0}}</Output>
<Note>Header "Government of India" lost to OCR — still AADHAAR: name + DOB + gender + grouped 12-digit number = 4 signals. "8416 1590 3267" → spaces stripped. "MALE" inside noise line → gender 0.7. Garbled Hindi lines ("Umps prer", "a5 - ar srrent…") ignored, NOT copied. Address unreadable → null + 0.0, never "".</Note>
</Example1>

<Example2>
<Input>
SMASH TAT 1H HARA AIH
INCOME TAX DEPARTMENT €p GOVT OF INDIA
HegHe
TWITTERPREET SINGH = Poe
BALWINDER SINGH + ae Be
SU 95 4 i Gh edts
Permanent Account Number Y Lid {
BWZPS1234R a oe
Twitterpreet Singh bh ve 3
Signature J la i %
</Input>
<Output>{"type":"PAN","id":{"pan_number":"BWZPS1234R"},"personal":{"name":"TWITTERPREET SINGH","father_name":"BALWINDER SINGH","dob":null},"confidence":{"pan_number":1.0,"name":0.7,"father_name":0.7,"dob":0.0}}</Output>
<Note>NOT UNKNOWN — "INCOME TAX DEPARTMENT" + "Permanent Account Number" + AAAAA9999A pattern are decisive. On PAN cards the holder's name comes first, father's name second. Trailing junk ("= Poe", "+ ae Be") stripped from values. "Y Lid {" after "Permanent Account Number" is gibberish — the actual value is the pattern match BWZPS1234R on the next line. dob not readable → null, NOT invented.</Note>
</Example2>

<Example3>
<Input>
HR TUNTSY / REPUBLIC OF INDIA
iE No WRdE/NDIAN 20000000
IGA / Surname
SPECIMEN pr —
fat a1 ART / Given Namels) A ) ; = B= en,
~~ KUMAR 6 ETE
Fifa / Date of Birth RT / Sex
W 23 24/05/1985 M
WAT Tar / Pace of Birth
MUMBAI, MAHARASHTRA
FTE FRA BT RT / Place of Issue
BANGALORE
Date of Issue Fifa $ ff 7 Date of Expiry
L 01/01/2013 01/01/2023
P<<SPECIMEN<<KKUMAR<LGLLLLLLLLLLLLKLLLKLLKLKLLLKLKLKLKL
219999999<0IND8505246M2300000<<<<<<K<<<<L<K<LK<LKL<L4
</Input>
<Output>{"type":"PASSPORT","personal":{"name":"SPECIMEN KUMAR","dob":"24/05/1985","gender":"M","nationality":"INDIAN","place_of_birth":"MUMBAI, MAHARASHTRA"},"document":{"passport_number":"20000000","issue_date":"01/01/2013","expiry_date":"01/01/2023","file_number":null},"mrz":"P<<SPECIMEN<<KKUMAR<LGLLLLLLLLLLLLKLLLKLLKLKLLLKLKLKLKL\\n219999999<0IND8505246M2300000<<<<<<K<<<<L<K<LK<LKL<L4","confidence":{"name":0.7,"dob":1.0,"gender":1.0,"nationality":0.7,"place_of_birth":1.0,"passport_number":0.7,"issue_date":1.0,"expiry_date":1.0,"file_number":0.0,"mrz":0.7}}</Output>
<Note>NOT UNKNOWN — "REPUBLIC OF INDIA" + MRZ lines with "<<" are decisive. Surname under "Surname" label + given name under "Given Name(s)" label → combined name. PASSPORT NUMBER: the token right after the "REPUBLIC OF INDIA(N)" line ("iE No WRdE/NDIAN 20000000") is the Indian passport number → "20000000", confidence 0.7 (digits readable, surrounding line noisy). Do NOT read it from the MRZ digits. file_number is optional and not printed here → null + 0.0. Labels appear bilingual ("Fifa / Date of Birth") — read the English half, take the value near it.</Note>
</Example3>

<Example4>
<Input>
xK9# wel2ome pg @@ HegHe
Ref: 4521 Date: 03/01/2024
</Input>
<Output>{"type":"UNKNOWN","reason":"No document type signals matched; only a reference number and date are readable","possible_type":null,"raw_fields":{"ref":"4521","date":"03/01/2024"},"confidence":{"ref":0.7,"date":0.7}}</Output>
</Example4>
</Examples>`;

const STEPS_BLOCK = `<Steps>
1. SCAN: read the OCR text; note recognizable keywords, names, numbers, dates. Skip gibberish tokens.
2. CLASSIFY: test Detection signals top-to-bottom; first type with ALL its signals present wins; fewer than 2 signals → UNKNOWN.
3. EXTRACT: fill that type's schema. Copy each value EXACTLY as written; fix only obvious single-character OCR swaps (0↔O, 1↔I/l, 5↔S, 8↔B).
4. NULL: every field not visible in the OCR → null. Do not guess or complete partial values.
5. CONFIDENCE: score every schema field using the ConfidenceRubric.
6. SELF-CHECK before answering: output is one valid JSON object; keys and nesting EXACTLY match the chosen schema; no empty strings (missing → null); every null field has confidence 0.0; aadhaar_number is exactly 12 digits (spaces stripped); pan_number matches AAAAA9999A; "confidence" covers every schema field; no text outside JSON.
</Steps>`;

// Full version — Gemini / Groq (70B-class). All blocks + 3 few-shot examples.
export const UNIFIED_PROMPT = `You are an expert document parser for Indian identity and business documents. You read noisy OCR text, identify the document type, and extract fields into a strict JSON schema.
Output ONLY one valid JSON object. No explanation, no markdown.

${STEPS_BLOCK}

${DETECTION_BLOCK}

${SCHEMAS_BLOCK}

${CONFIDENCE_RUBRIC}

${NEVER_BLOCK}

${FEW_SHOT_BLOCK}`;

// Compact version — small local models (phi3 etc.). One example, short rules,
// same schemas. Keeps the context small so JSON output stays reliable.
export const UNIFIED_PROMPT_LOCAL = `You are a document parser. Read OCR text, pick document type, fill the matching schema. Output ONLY one valid JSON object.

${DETECTION_BLOCK}

${SCHEMAS_BLOCK}

<Rules>
- Field not visible in OCR → null (never empty string ""). NEVER invent values.
- Copy keys and nesting EXACTLY from the schema. No extra fields. No moved fields.
- Copy values exactly; fix only obvious char swaps (0↔O, 1↔I/l).
- Ignore gibberish tokens ("HegHe", "vgs}", "TT TT SEER") — never copy them into values.
- aadhaar_number: 12 digits no spaces | pan_number: AAAAA9999A
- ID patterns (12-digit grouped number, AAAAA9999A, MRZ "<<") beat missing headers — do NOT answer UNKNOWN when one is present.
- Add top-level "confidence":{field:score} for every schema field: 1.0 clear | 0.7 noise fixed | 0.4 partial | 0.0 null
- UNKNOWN: put readable key-value pairs into raw_fields
</Rules>

<Example1>
<Input>
Sriram Mamundi
Umps prer / DOB : 11/04/1992
oir | MALE SIS he >
8416 1590 3267  EEHEEl
</Input>
<Output>{"type":"AADHAAR","id":{"aadhaar_number":"841615903267"},"personal":{"name":"Sriram Mamundi","dob":"11/04/1992","gender":"Male","address":null},"confidence":{"aadhaar_number":1.0,"name":1.0,"dob":1.0,"gender":0.7,"address":0.0}}</Output>
</Example1>

<Example2>
<Input>
INCOME TAX DEPARTMENT €p GOVT OF INDIA
HegHe
TWITTERPREET SINGH = Poe
BALWINDER SINGH + ae Be
Permanent Account Number Y Lid {
BWZPS1234R a oe
</Input>
<Output>{"type":"PAN","id":{"pan_number":"BWZPS1234R"},"personal":{"name":"TWITTERPREET SINGH","father_name":"BALWINDER SINGH","dob":null},"confidence":{"pan_number":1.0,"name":0.7,"father_name":0.7,"dob":0.0}}</Output>
</Example2>`;

// ─── Gemini evaluation: rich 7-dimension scoring of actual extraction output ──

export const EVALUATION_PROMPT_GEMINI = (
  docType: string,
  ocrText: string,
  extractedJson: string,
): string => `You are a strict document-extraction quality auditor. Judge ONLY from evidence in the OCR text below — never from what a typical document "should" contain. When uncertain, score lower.

=== DOCUMENT TYPE (claimed) ===
${docType}

=== RAW OCR TEXT (ground truth) ===
${ocrText}

=== EXTRACTED JSON (model output under audit) ===
${extractedJson}

=== PROCEDURE (follow in order) ===
1. List the fields clearly readable in the OCR text (names, dates, IDs, amounts, contacts).
2. For each extracted value, verify it appears in the OCR text (allowing obvious single-char OCR fixes like 0↔O, 1↔I). A value with no OCR evidence is FABRICATED.
3. Score each dimension: gather evidence, write the "reason" citing that evidence FIRST, then assign the score from the anchors. "strength"/"weakness" must reference concrete fields, not generalities.
4. Apply the hard caps below — they override anchor scores.
5. Compute overall_score as the exact arithmetic mean of all 7 dimension scores, rounded to 1 decimal. Example: 8,7,9,6,8,7,8 → 53/7 = 7.6.

=== SCORE ANCHORS (every dimension, INTEGER 0–10) ===
10 = flawless, zero counter-evidence
8  = one minor issue, nothing critical
6  = several minor issues, no critical field affected
4  = at least one critical field (name/dob/id) wrong or missed
2  = majority wrong or missing
0  = complete failure

=== DIMENSION DEFINITIONS ===
type_detection          → Was "${docType}" the correct type per OCR markers? 10=correct, 0=wrong.
field_coverage          → Fraction of OCR-visible fields present in extracted JSON.
value_accuracy          → Do extracted values match the OCR text exactly (after legitimate noise fixes)?
ocr_noise_handling      → Were OCR artifacts (swapped chars, merged words, gibberish) handled — fixed when obvious, excluded when meaningless?
json_output_reliability → Is the JSON valid, well-formed, schema-compliant, types correct?
completeness            → Are critical fields (name/date/id/contact) populated (not null/empty)?
confidence_calibration  → Do per-field confidence scores track actual OCR clarity? High confidence on a wrong value = miscalibration; 0.0 on null fields = correct.

=== HARD CAPS (override anchors) ===
- Wrong document type → type_detection = 0
- ANY fabricated value → value_accuracy ≤ 2 AND production_ready = false
- Invalid JSON or wrong schema keys → json_output_reliability ≤ 3
- Half or more of critical fields null while clearly readable in OCR → completeness ≤ 4
- Confidence ≥ 0.9 on any wrong value → confidence_calibration ≤ 4

=== CONSISTENCY RULES ===
- overall_score MUST equal the arithmetic mean of the 7 dimension scores (1 decimal)
- grade follows overall_score: A=9–10 | B=7–8.9 | C=5–6.9 | D=3–4.9 | F=0–2.9
- production_ready = (overall_score >= 7.5) AND no fabricated values
- OPTIONAL FIELDS: a null/absent field is a defect ONLY if its value is clearly readable in the OCR. Many schema fields are optional (e.g. address, nominee, file_number, linkedin) and are simply not on every document — when such a field is absent from the OCR, its null value is CORRECT. Never list it in missing_fields and never lower field_coverage or completeness for it.
- missing_fields: ONLY field names whose value is clearly readable in the OCR but is null/absent in the extracted JSON (empty array if none). A field with no OCR evidence is NOT missing.
- recommended_improvements: max 5 concrete, actionable fixes (short strings)

Return ONLY the JSON object. No explanation outside it.`;

// ─── Evaluation output structure ──────────────────────────────────────────────
// Gemini enforces this via responseSchema; Groq's json_object mode has no schema
// support, so the structure must be spelled out in the prompt text.

export const EVALUATION_OUTPUT_STRUCTURE = `
Return JSON with EXACTLY this structure (all 7 dimensions required):
{
  "document_type": "<string>",
  "overall_score": <number>,
  "grade": "<A|B|C|D|F>",
  "dimensions": {
    "type_detection":          { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" },
    "field_coverage":          { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" },
    "value_accuracy":          { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" },
    "ocr_noise_handling":      { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" },
    "json_output_reliability": { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" },
    "completeness":            { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" },
    "confidence_calibration":  { "score": <int 0-10>, "reason": "<string>", "strength": "<string>", "weakness": "<string>" }
  },
  "missing_fields": ["<string>", ...],
  "recommended_improvements": ["<string>", ...],
  "production_ready": <boolean>
}`;

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

FIRST: list every leaf field in Extracted that has a non-null, non-empty value (e.g. name="Sriram Mamundi", dob="11/04/1992"). Count them. Use this count below — do NOT claim "no fields" when this list is not empty.

type_detection: 10 if extracted.type matches DocType exactly, 0 if wrong type.
  reason: explain match/mismatch. strength: what was correct. weakness: what was wrong.

field_coverage: count only fields whose value is readable in the OCR; of those, how many are filled (non-null) in Extracted. score = filled / readable-in-OCR * 10, round to integer. A field that is null because its value is NOT in the OCR (including optional fields like address/file_number/nominee) is NOT a miss — exclude it from both counts.
  reason: state the two counts, e.g. "3 of 4 OCR fields filled → 8". strength: which key fields found. weakness: which OCR-readable fields are still null.

value_accuracy: for each non-null value, check it appears in the OCR text. 10=all appear, 5=half appear, 0=values not in OCR (fabricated).
  reason: name the values checked and any mismatch. strength: values that match exactly. weakness: values that are wrong or fabricated.

completeness: check name/date/id/email/address fields. 10=all filled, 0=all null.
  reason: list what is null. strength: filled fields. weakness: null fields.

HARD CAPS: wrong type → type_detection=0. Any value not found in OCR → value_accuracy max 2.

overall_score: (type_detection + field_coverage + value_accuracy + completeness) / 4, rounded to 1 decimal.
  EXAMPLE: scores 8, 6, 7, 5 → overall_score = 6.5 (NOT 0.65)

grade: A=9-10 | B=7-8 | C=5-6 | D=3-4 | F=0-2
production_ready: true if overall_score >= 7.5
missing_fields: array of field names visible in OCR but null in Extracted (empty array if none)
recommended_improvements: array of max 3 short fix strings (empty array if none)
</Rules>

Return JSON with this exact structure:
{"document_type":"${docType}","overall_score":0,"grade":"F","dimensions":{"type_detection":{"score":0,"reason":"","strength":"","weakness":""},"field_coverage":{"score":0,"reason":"","strength":"","weakness":""},"value_accuracy":{"score":0,"reason":"","strength":"","weakness":""},"completeness":{"score":0,"reason":"","strength":"","weakness":""}},"missing_fields":[],"recommended_improvements":[],"production_ready":false}`;