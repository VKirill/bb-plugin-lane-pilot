---
title: Invoice rules
type: component
created: 2026-11-13
updated: 2026-11-13
status: active
confidence: medium
tags: [kit, invoices, validation, pii]
sources:
  - packages/kit/src/invoice-rules.ts
  - packages/kit/package.json
  - packages/kit/src/index.ts
  - src/rooms/workflow/server/workflow-invoice.ts
  - src/rooms/anamnesis/pii.ts
  - src/rooms/validators/deliverable.ts
---

# Invoice rules

TL;DR: The invoice rules check numeric and banking fields exactly, then use word overlap to classify client and service names (packages/kit/src/invoice-rules.ts:36-74).

## Purpose

This module exposes pure rules for checking an invoice against a request. The workflow invoice action uses the verdict and reasons, while the PII scanner reuses validInn to identify valid INNs without a label (src/rooms/workflow/server/workflow-invoice.ts:1, src/rooms/workflow/server/workflow-invoice.ts:36-46, src/rooms/anamnesis/pii.ts:1, src/rooms/anamnesis/pii.ts:62-63).

## How it works

1. **Validate INNs (validInn):** Remove whitespace, require decimal digits and accept only 10-digit or 12-digit values whose control digits match (packages/kit/src/invoice-rules.ts:17-27).
2. **Validate bank accounts:** validAccount checks a 9-digit BIK and 20-digit account with a checksum seeded by the BIK's last three digits. validCorrAccount checks a 20-digit correspondent account with the prefix 0 and BIK digits 5–6 (packages/kit/src/invoice-rules.ts:29-33).
3. **Collect hard problems (hardProblems):** Require an invoice number and client name, require positive finite request and invoice amounts, compare amounts within a tolerance of 0.005, validate the client's INN and compare it to a supplied request INN, validate a supplied payee INN, and check the BIK and both accounts (packages/kit/src/invoice-rules.ts:36-53).
4. **Compare names (overlap):** Lowercase and split text into unique words, remove words of two characters or fewer and listed legal forms, then divide shared words by the smaller word set size (packages/kit/src/invoice-rules.ts:56-65).
5. **Return a verdict (invoiceVerdict):** Any hard problem yields mismatch. With no hard problems, company overlap of at least 0.6 and service overlap of at least 0.5 yields match; all other word comparisons yield unsure (packages/kit/src/invoice-rules.ts:67-74).

### Modes and thresholds

| Condition | Inputs checked | Result | Evidence |
|---|---|---|---|
| One or more hard problems | Number, amounts, client name and INN, optional payee INN, BIK and accounts | mismatch with each hard problem in reasons | packages/kit/src/invoice-rules.ts:36-53, packages/kit/src/invoice-rules.ts:68-70 |
| No hard problems; company overlap ≥ 0.6 and service overlap ≥ 0.5 | Unique normalized words in requested and invoice company/service names | match with rounded overlap percentages | packages/kit/src/invoice-rules.ts:71-73 |
| No hard problems; either overlap is below threshold | Same name fields | unsure with a review reason | packages/kit/src/invoice-rules.ts:71-74 |

### Failures

| Failure | Result | Evidence |
|---|---|---|
| Missing invoice number or client name | Adds a hard problem; invoiceVerdict returns mismatch | packages/kit/src/invoice-rules.ts:39, packages/kit/src/invoice-rules.ts:44, packages/kit/src/invoice-rules.ts:68-70 |
| Non-finite or non-positive amount | Adds a hard problem and returns mismatch | packages/kit/src/invoice-rules.ts:41-43, packages/kit/src/invoice-rules.ts:68-70 |
| Invalid or unequal INN, malformed BIK or checksum-invalid account | Adds a hard problem and returns mismatch | packages/kit/src/invoice-rules.ts:45-51, packages/kit/src/invoice-rules.ts:68-70 |
| Numeric and banking checks pass but names do not meet both thresholds | Returns unsure rather than match | packages/kit/src/invoice-rules.ts:71-74 |

## Business rules

- The request INN is optional for equality comparison, but the invoice client's INN must always be valid. A payee INN is checked only when supplied (packages/kit/src/invoice-rules.ts:45-47).
- The BIK must be nine digits starting with 04; account validation runs only after the BIK passes this format check (packages/kit/src/invoice-rules.ts:48-51).
- A blank request company or service name has zero overlap and cannot satisfy the corresponding match threshold (packages/kit/src/invoice-rules.ts:59-64, packages/kit/src/invoice-rules.ts:71-73).
- The rule module performs the checks in code; the workflow invoice action returns the verdict and reasons with by: "rules" (packages/kit/src/invoice-rules.ts:68-74, src/rooms/workflow/server/workflow-invoice.ts:45-46).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| InvoiceRequest | type | Request company, amount, service and optional-comparison INN | packages/kit/src/invoice-rules.ts:8 |
| InvoiceFound | type | Invoice number, client fields, amount, service and payment bank fields | packages/kit/src/invoice-rules.ts:9-12 |
| InvoiceCheckInput | type | Groups the request and found invoice | packages/kit/src/invoice-rules.ts:13 |
| InvoiceVerdict | type | "match", "mismatch" or "unsure" | packages/kit/src/invoice-rules.ts:14 |
| InvoiceCheckDecision | type | Verdict plus explanatory reason strings | packages/kit/src/invoice-rules.ts:15 |
| validInn | function | Checks a 10- or 12-digit INN control sum | packages/kit/src/invoice-rules.ts:19-27 |
| validAccount, validCorrAccount | functions | Check account control sums against BIK fields | packages/kit/src/invoice-rules.ts:29-33 |
| hardProblems | function | Returns all hard field and numeric problems found | packages/kit/src/invoice-rules.ts:35-53 |
| overlap | function | Returns the shared-word fraction over the shorter normalized word set | packages/kit/src/invoice-rules.ts:56-65 |
| invoiceVerdict | function | Combines hard checks and name thresholds into a decision | packages/kit/src/invoice-rules.ts:67-74 |

The module is available from both the package root and the @lane-pilot/kit/invoice-rules subpath (packages/kit/src/index.ts:16, packages/kit/package.json:15).

## Gotchas

- Name matching uses shared words, not semantic similarity; passing numeric checks alone produces unsure unless both name thresholds pass (packages/kit/src/invoice-rules.ts:56-74).
- The supplied payee INN is format-checked, not compared with the request INN (packages/kit/src/invoice-rules.ts:45-47).
- The workflow caller builds the input from action parameters; this module expects the typed InvoiceCheckInput shape directly (src/rooms/workflow/server/workflow-invoice.ts:19-27, packages/kit/src/invoice-rules.ts:8-15).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit workspace overview](../overview.md)
