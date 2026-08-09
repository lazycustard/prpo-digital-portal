# PR-PO Portal — PPT vs Implementation Gap Analysis

Source: **PR-PO Process.pptx** (83 slides) compared against the current code
(`pr_portal.html` frontend, `backend/server.js` + RBAC modules).

Legend: ✅ Matches · ❌ Mismatch · ⚠️ Cannot be verified from PPT (under-specified — must NOT be invented).

> Scope note: the PPT specifies **workflow, roles, thresholds, and named example fields/codes**,
> but it does **not** enumerate the full contents of most dropdowns. Every place the PPT shows only
> an example is marked ⚠️ and left for business to confirm — not guessed.

---

## A. Authentication / Login

### A1. Multi-Factor Authentication ❌
- **PPT ref:** Slides 22, 39, 52, 61 (every module: "Login details — Input Mail Id / Input Password / Multi-factor Authentication to be followed").
- **Current:** `backend/auth.js` — email + bcrypt password → JWT. **No MFA step.**
- **Difference:** PPT mandates MFA after email+password on every login. Not implemented.
- **Fix:** Add an MFA step (e.g. email OTP / TOTP) after password verification before issuing the JWT.
- **Note:** This directly contradicts the manager's written statement ("No OTP service… no SMS/OTP flow"). The PPT and the live system disagree — needs a business decision before building.

### A2. Login is described per-module ⚠️
- **PPT ref:** Login shown separately on slides 22 (PR), 39 (PO), 52 (Invoice), 61 (Plant).
- **Current:** Single login for the whole portal (SSO-style).
- **Difference:** PPT repeats a login screen per module; almost certainly one login, shown per section for clarity. Cannot confirm intent from PPT.
- **Fix:** Confirm with business; single login is the reasonable reading.

---

## B. PR Process (Proposed) — Slides 19–34

### B1. Function is a free dropdown for everyone ❌
- **PPT ref:** Slide 23 — "For all users except marketing, the function will be **pre-decided as per login masters**; only for marketing the dropdown is displayed."
- **Current:** `pr_function` is an open dropdown for all users.
- **Difference:** Function must be **auto-set from the logged-in user's master** (locked), except Marketing which gets a dropdown.
- **Fix:** Read function from the user record; render it read-only for non-Marketing; only show the dropdown for Marketing users.

### B2. Function dropdown values are wrong ❌ / ⚠️
- **PPT ref:** Slides 11, 13, 23, 31 — functions are **ASG, Marketing, Infosec, Infrastructure (Infra), Manufacturing (MFG)**, and elsewhere **RMC, BPD, UTEC**.
- **Current:** `Information Technology, Operations, Finance, HR, Marketing`.
- **Difference:** Current uses generic corporate functions; PPT uses Alliance-specific ones.
- **Fix:** Replace function list with the PPT set (ASG, Marketing, Infosec, Infrastructure, Manufacturing, RMC, BPD, UTEC). ⚠️ The **complete** authoritative list is not fully enumerated on one slide — confirm the master list with business.

### B3. Category / Line Item / Budget-code values ⚠️
- **PPT ref:** Slides 24, 54, 63 give only **examples** ("if MFG selected, these categories appear"; codes like `OPX-MFG-UTC-AMC-CLIP-01`, `OPX-ASG-UTC-BKUP-DTC-00`).
- **Current:** Generic values (`Software Licenses / Hardware / Professional Services / Infrastructure`; codes `OPX-IT-UTC-LIC-SAAS-01`).
- **Difference:** Current data is placeholder and does not match PPT examples.
- **Fix:** ⚠️ The PPT does **not** list every category/line-item per function, so the full dropdowns **cannot be reconstructed from the PPT**. Requires the budget-line master (Function → Category → Line Item → Code) from business. The code-generation *pattern* (`OPX-<FUNC>-UTC-<CAT>-<ITEM>-NN`) can be matched once the master is supplied.

### B4. Unique budget code format ❌
- **PPT ref:** Slides 24/54/63 — auto-generated code e.g. `OPX-MFG-UTC-AMC-CLIP-01`.
- **Current:** `pr_bcode` auto-fills from a hard-coded map with `OPX-IT-...` style codes.
- **Difference:** Generated codes don't follow the PPT master (wrong function segments/items).
- **Fix:** Generate from the real master once B3 data exists.

### B5. Budget display (Allocated / Utilised / Available) ✅
- **PPT ref:** Slide 25.
- **Current:** Budget step shows Allocated / Utilized / Available. Matches.

### B6. Units / Quantity / Rate → PR Value ✅ (mostly)
- **PPT ref:** Slide 26 — Units, Quantity, Rate; Value = Qty × Rate; "if Nos not there, input 1".
- **Current:** `pr_units/pr_qty/pr_rate`, `pr_value` = qty×rate (read-only). Matches. ⚠️ Units dropdown values (Nos/Licenses/Months/Years/Lumpsum) are not enumerated in PPT — cannot verify.

### B7. Shared-expense allocation table missing columns ❌
- **PPT ref:** Slide 27 — allocation sub-flow columns: **Function, Category, Line Item, Allocated, Utilised, Available, Unique Code, Percent (%), Amount, Add Level**.
- **Current:** Allocation table columns: Function, Category, Line Item, Unique Code, %, Amount. **Missing Allocated / Utilised / Available** columns.
- **Difference:** Three budget-visibility columns absent from the allocation rows.
- **Fix:** Add Allocated / Utilised / Available columns to the allocation table (per selected line item).

### B8. Within Budget / Budget Exceeded ✅
- **PPT ref:** Slide 28.
- **Current:** Shows "Within budget" and "Budget Exceeded" and restricts progress. Matches.

### B9. SAP item-detail fields missing from PR form ❌
- **PPT ref:** Slide 29 — Item No, Acct Assignment Category (Capex(P)/Opex(K)), Item Category (D), Purchase Group (C06), Department (ITM), Tracking No, Purchase Organisation (6000), Material Group (Services), Plant, Add Level.
- **Current:** Regular PR form has **none** of these (they exist only in the IPR form). PR steps are Basic / Budget / Amount / Validity / Additional(Tax, Cost Centre, Remarks) / SoW / Review.
- **Difference:** The standard PR flow is missing the entire SAP item-detail section from slide 29.
- **Fix:** Add the slide-29 fields to the PR form. ⚠️ Their dropdown values are given only as examples — confirm masters.

### B10. Delivery Date = End Date + 3 months ✅
- **PPT ref:** Slide 30.
- **Current:** `pr_delivery` computed as End + 3 months. Matches.

### B11. Tax Applicability ⚠️
- **PPT ref:** Slide 30 — "Tax Applicability" dropdown (values not listed).
- **Current:** GST 18% / 12% / 5% / Exempt. ⚠️ Cannot verify values against PPT.

### B12. Cost Centre — conditional auto vs dropdown not implemented ❌
- **PPT ref:** Slide 31 — Cost Centre **auto-populated** for Manufacturing/Marketing/RMC/BPD/UTEC; **dropdown** for ASG/Infosec/Infra.
- **Current:** Cost Centre is always a dropdown (`pr_cc`) with generic values.
- **Difference:** Conditional behaviour (auto vs dropdown by function) not implemented; values generic.
- **Fix:** Auto-populate for the listed functions, dropdown for ASG/Infosec/Infra. ⚠️ Actual cost-centre values not in PPT.

### B13. Internal Order No / G/L Account / CO Area missing from PR form ❌
- **PPT ref:** Slide 32 — Internal Order No (for Marketing/UTEC), G/L Account (e.g. 730340), CO Area (e.g. GIL), auto-populated by function.
- **Current:** Not present on the regular PR form (only on IPR).
- **Difference:** Missing on PR.
- **Fix:** Add these to the PR form with function-based auto-population.

### B14. Scope of Work — Agentic AI description ❌ (partial)
- **PPT ref:** Slide 31 — "Agentic AI will read the attached SoW and auto-generate the description… subject to review/modification/approval by the application owner."
- **Current:** SoW upload works; an "AI Generated" summary box exists but contains **static hard-coded text**, no actual AI processing.
- **Difference:** No real AI generation from the uploaded document.
- **Fix:** Wire the upload to an actual model that generates the description; keep it editable. (Placeholder acceptable only if explicitly a stub.)

### B15. Approver auto-population (approver names) ❌
- **PPT ref:** Slide 33 — Approvers auto-populated from user mapping: **Approver 1 Business Commercial Approval (Marketing/RMC/BPD only), Approver 2 Governance Head / function person, Approver 3 Portfolio Lead, Approver 4 CDIO.**
- **Current:** No approver-list section; the "Done" screen shows a generic "Pending L1 Approval".
- **Difference:** The auto-populated 4-approver panel (incl. conditional Business Commercial approver) is absent.
- **Fix:** Add an approver panel populated from user mappings and amount; include the Business Commercial approver only for Marketing/RMC/BPD.

### B16. Submit → SAP via BAPI ❌
- **PPT ref:** Slide 34 — "Once submit, PR created in SAP via BAPI."
- **Current:** Submit writes to Postgres only; no SAP/BAPI call.
- **Difference:** No SAP integration.
- **Fix:** Integrate the SAP BAPI (or clearly mark as a stub). ⚠️ SAP endpoint details not in PPT.

### B17. Status terminology ❌ (minor)
- **PPT ref:** Slides 4–6 — PR is "raised" then "**released** in SAP".
- **Current:** Statuses `Draft, Submitted, Pending Approval, Approved, Rejected, Cancelled` — uses "Approved" not "Released".
- **Difference:** Terminology differs ("Approved" vs "Released").
- **Fix:** Confirm whether "Released" should replace/augment "Approved".

### B18. Generated ID format ❌ (minor)
- **PPT ref:** Slides 72, 77 dashboards show IDs like `PR-26-0418`, `INV-2247`.
- **Current:** `PR/2025-26/000001`, `INV/2025-26/000001`.
- **Difference:** Different ID pattern.
- **Fix:** Confirm the canonical format; align generator.

---

## C. PR Approval Workflow & Thresholds

### C1. Amount thresholds ✅ (values) — implemented as bands
- **PPT ref:** Slides 71, 76, 82 — **≤ ₹2.5L → Governance/DH, ₹2.5L–₹25L → Portfolio Lead, > ₹25L → CDIO.**
- **Current:** RBAC role approval bands exactly encode these. Matches.

### C2. Multi-approver sequential chain ❌
- **PPT ref:** Slides 5–6, 33 — a PR can require **several approvers in sequence** (Governance Head → Portfolio Lead → CDIO; plus Business Commercial for Mkt/RMC/BPD).
- **Current:** A single `approve` action gated by the approver's amount band; **no sequential multi-step routing**, no Business Commercial step.
- **Difference:** Current approves in one step by band; PPT routes through an ordered chain.
- **Fix:** Model an approval chain (ordered approver list per PR, each must act) rather than a single approval. Add the conditional Business Commercial approval for Marketing/RMC/BPD.

### C3. Plant/Infra release authority chain ❌
- **PPT ref:** Slide 13 — Plants: Section Head / DH / Function Head / COO + **Commercial Department Head as final release authority**; slide 82 proposes DH/PL/CDIO for plants.
- **Current:** No plant-specific approval chain; IPR uses the same single-band approval.
- **Difference:** Plant approval hierarchy not modelled.
- **Fix:** Implement the plant release-authority chain (or the slide-82 proposed DH/PL/CDIO) for Infra/plant PRs.

### C4. Infra PR routed to a specific approver ❌
- **PPT ref:** Slide 69 — plant PR "routed to **Pankaj sir** for approval, then created in SAP via BAPI."
- **Current:** IPR uses generic band approval.
- **Difference:** Named/role-specific routing for Infra not implemented.
- **Fix:** Route Infra PRs to the designated approver role.

---

## D. IPR / Plant (Infra) Process — Slides 58–69

### D1. Cross-FY allocation timing ❌
- **PPT ref:** Slide 65 — when validity spans multiple FYs (>12 months), each FY's amount is **blocked/reserved from that FY's budget at PR creation**; no separate PR needed later.
- **Current:** IPR stores FY allocations; budget is deducted **at approval**, not creation.
- **Difference:** Reservation timing differs (creation vs approval), and there is no "future-year reserved, no new PR needed" concept.
- **Fix:** Block each FY's amount at PR creation; validate each FY allocation ≤ that FY's available budget at creation.

### D2. Function auto = Infra ✅
- **PPT ref:** Slide 62. **Current:** `ipr_function` locked to Infra. Matches.

### D3. Cross-FY validation against each FY budget ✅ (partial)
- **PPT ref:** Slide 65 — "if current-year allocation ≤ that FY's available budget."
- **Current:** On approve, each allocation checked against its FY budget line. Logic present but at wrong time (see D1).

---

## E. PO Process — Slides 36–45

### E1. Vendor NOT-IN-LIST → Vendor Management ❌ (partial)
- **PPT ref:** Slide 40 — selecting "NOT IN LIST" triggers a **system prompt to complete the Vendor Management process before proceeding**; on vendor select, auto-populate Vendor Code / Address / Tax code.
- **Current:** `NOT_IN_LIST` option exists but there is no vendor-management prompt/flow; auto-population of code/address/tax not wired to real vendor master.
- **Difference:** Vendor Management sub-process and auto-population missing.
- **Fix:** Add the prompt + vendor onboarding flow; auto-fill vendor code/address/tax from the vendor master. ⚠️ Vendor list values are placeholders (TCS/Infosys…) — not from PPT.

### E2. PO value cannot exceed PR value ✅
- **PPT ref:** Slide 41. **Current:** enforced in `/api/po`. Matches.

### E3. Milestones ✅ (mostly)
- **PPT ref:** Slide 42 — Stages, % of Amount, Amount, Add Level; Payment Terms has a "Milestone-Based" option.
- **Current:** PO milestones (name/%/amount, add level) implemented. ⚠️ Payment-terms values not enumerated in PPT.

### E4. Inco Terms ⚠️
- **PPT ref:** Slide 43 — Inco Terms; for services choose **FOR**, "Incoterms Location 1" auto = "Site".
- **Current:** Full incoterms dropdown (EXW…CIF); no FOR option, no auto "Site" location.
- **Difference:** PPT only specifies FOR + Site auto-fill for services; current lacks FOR and the auto-location.
- **Fix:** Add FOR and the auto "Site" location behaviour. ⚠️ Full incoterm list not specified by PPT.

### E5. Negotiation section ✅ / ⚠️
- **PPT ref:** Slide 44 — Negotiation Done Yes/No; Rate Card options **ABMCPL / BMCSPL / UTCL / Others**; Single Vendor; Level of Negotiation (First/Second, Add Level); Negotiating Party; remarks; Supporting Document.
- **Current:** Status dropdown (Negotiation Pending / Single Vendor / Rate Card), Rate Card sub-options exactly ABMCPL/BMCSPL/UTCL/Others, negotiation levels, outcome. Largely matches. ⚠️ "Negotiating Party" dropdown values not in PPT.

### E6. PO Category / Header Text auto ❌ (partial)
- **PPT ref:** Slide 45 — Header Text auto-populated (different standard text for ASG/Infosec/Infra/Mfg vs Mktg/BPD/RMC/UTEC), plus Purchase Group / Purchase Organisation.
- **Current:** No function-conditional header-text auto-population evident.
- **Fix:** Auto-populate header text per function group.

### E7. PO → Vendor confirmation status ✅ (roughly)
- **PPT ref:** Slide 7 — PO sent to vendor, vendor confirms within 3 working days.
- **Current:** PO statuses include `Sent to Vendor`, `Vendor Confirmed`. Matches conceptually; the 3-day SLA/confirmation loop is not automated.

---

## F. Invoice / Service Entry Process — Slides 8–10, 49–57

### F1. Invoice approval workflow entirely missing ❌
- **PPT ref:** Slides 8–10 — invoice reviewed → App Owner approves → **Portfolio Lead approves if ≤ ₹10L, CDIO if > ₹10L** → Service Entry released in SAP → (MIGO where applicable) → sent to UKSC for Case ID.
- **Current:** `/api/invoice` submits the invoice and **immediately deducts budget**; there is **no approval workflow, no Service Entry release, no MIGO, no UKSC Case ID**.
- **Difference:** The whole multi-step invoice approval + service-entry + MIGO + UKSC chain is absent.
- **Fix:** Add invoice approval routing (App Owner → PL ≤10L / CDIO >10L), a Service Entry release step, MIGO handling, and UKSC Case ID creation.

### F2. Invoice fields ✅ (mostly)
- **PPT ref:** Slides 53–56 — FY, Cost Type, Function, Category, Line Item, code, budget display, Short Text, Service Entry No, Service Period, Invoice Date, Invoice Number, Invoice Amount.
- **Current:** All these fields present. Matches. (Function values wrong per B2.)

### F3. Duplicate invoice check ✅
- **PPT ref:** Slide 57 — duplicate check on **Vendor + Invoice Number + Invoice Date**.
- **Current:** Exactly this check in `/api/invoice` and `/check-duplicate`. Matches.

### F4. Auto budget deduction on submit ✅
- **PPT ref:** Slide 57. **Current:** budget `used_amount` incremented + ledger entry. Matches.

### F5. Filled by Governance Team ✅
- **PPT ref:** Slide 51. **Current:** `invoice:create` permission is Governance-only. Matches.

---

## G. Roles & Permissions — Slides 70, 71, 76

### G1. Four personas ✅
- **PPT ref:** Slides 70–76 — Application Owner, Portfolio Lead, Governance Team (super-admin), CDIO.
- **Current:** Exactly these 4 roles with matching scope (own / portfolio / enterprise / enterprise-view). Matches.

### G2. Access-control matrix ✅ (mostly)
- **PPT ref:** Slide 76.
- **Current:** RBAC permissions mirror the matrix (Raise PR, view scopes, approve tiers, manage masters/budget/users, export). Matches. ⚠️ "Business Commercial Approval" (slide 33) is not represented as a role — see C2.

### G3. Manage masters / vendor / SAP integration controls ❌ (partial)
- **PPT ref:** Slide 76 — Governance manages vendor/line-item/user masters and SAP integration controls.
- **Current:** User management exists (`/api/admin`); **vendor/line-item master management and SAP controls are not implemented**.
- **Fix:** Add master-data management screens/APIs for vendors and budget line items.

---

## H. Dashboards, Notifications, Reports — Slides 70–77

### H1. Persona-specific dashboards ❌
- **PPT ref:** Slides 72–75 — distinct dashboards for AO, Portfolio Lead, Governance Team, CDIO, each with specific KPIs (pending-with-me, SLA timers, budget split, variance, top vendors, cycle time…).
- **Current:** One generic Governance dashboard (counts + budget usage).
- **Difference:** The four role-specific executive dashboards are not built.
- **Fix:** Build per-persona dashboards matching the slide layouts/KPIs.

### H2. Auto EOD Excel digest (email) ❌
- **PPT ref:** Slides 74, 77 — Excel digest **auto-emailed to Governance daily at 18:30 IST**, with defined sheets (PRs raised, released, exceptions, budget impact, reconciliation).
- **Current:** On-demand Excel export only; **no scheduling, no email, and not the PPT's 5-sheet structure**.
- **Difference:** Scheduled auto-email digest missing; sheet structure differs.
- **Fix:** Add a scheduled job (18:30 IST) emailing the digest via O365 SMTP; build the 5 sheets per slide 77.

### H3. Email notifications throughout ❌
- **PPT ref:** Multiple slides ("notified via email & portal", approver notifications).
- **Current:** No email/notification system.
- **Fix:** Add email notifications (O365 SMTP) at each workflow hand-off.

### H4. SLA timers / aging ❌
- **PPT ref:** Slides 72–74 — "pending with me", aging vs SLA (3 working days), breach flags.
- **Current:** Not implemented.
- **Fix:** Track aging per approval and flag SLA breaches.

---

## I. PR Modification — Slide 47

### I1. PR modification workflow ⚠️
- **PPT ref:** Slide 47 title "Proposed Workflow for Modification of PR" — **no detail/steps shown** on the slide (slide 48 is blank/number only).
- **Current:** No PR modification flow.
- **Difference:** Feature absent.
- **Fix:** ⚠️ **Cannot be specified from the PPT** — the modification workflow has no steps in the deck. Requires business input.

---

## Summary counts

- ✅ Matches: budget display, within/exceeded check, delivery+3m, PR value calc, PO≤PR, duplicate check, auto budget deduction, 4 roles + matrix, approval **threshold values**, negotiation rate-card options, invoice fields.
- ❌ Mismatches to fix: MFA, function auto-lock, function/category/line-item master data, SAP item fields on PR (slide 29), Internal Order/GL/CO Area on PR, conditional Cost Centre, approver auto-population + Business Commercial step, sequential multi-approver chains (PR/plant/infra), cross-FY reservation timing, vendor management flow, header-text auto, invoice approval + service entry + MIGO + UKSC, master-data management, persona dashboards, EOD email digest, email notifications, SLA aging, SAP/BAPI, Agentic AI SoW, ID format, "Released" status.
- ⚠️ Cannot be verified from PPT (do not invent): full dropdown value lists for Category, Line Item, Company, Vendor, Units, Tax, Cost Centre, Purchase Group/Org, Material Group, Plant, G/L, CO Area, Payment Terms, Negotiating Party, Inco Terms; complete authoritative Function master; PR-Modification workflow steps; exact SAP/BAPI + UKSC integration contracts; canonical ID format.
