"use strict";
const { useState, useMemo, useRef, useEffect } = React;
/* Standalone storage shim — same API as the Claude artifact runtime. */
if (!window.storage) {
    window.storage = {
        async get(k) { const v = localStorage.getItem(k); if (v == null)
            throw new Error("not found"); return { key: k, value: v }; },
        async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
        async delete(k) { localStorage.removeItem(k); return { key: k, deleted: true }; },
    };
}
/* ────────────────────────────────────────────────────────────
   DATE UTILITIES — all arithmetic in whole UTC days
   ──────────────────────────────────────────────────────────── */
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function parseDate(s) {
    if (!s)
        return null;
    const p = String(s).split("-").map(Number);
    if (p.length !== 3 || p.some((n) => Number.isNaN(n)))
        return null;
    const ms = Date.UTC(p[0], p[1] - 1, p[2]);
    return Number.isNaN(ms) ? null : ms;
}
function fmt(ms) {
    if (ms == null)
        return "—";
    const d = new Date(ms);
    return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function addYears(ms, n) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());
}
function diffDays(a, b) {
    return Math.round((a - b) / DAY);
}
function todayUTC() {
    const n = new Date();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
function ageParts(dob, target) {
    if (dob == null || target == null || target < dob)
        return null;
    const a = new Date(dob);
    const b = new Date(target);
    let y = b.getUTCFullYear() - a.getUTCFullYear();
    let m = b.getUTCMonth() - a.getUTCMonth();
    let d = b.getUTCDate() - a.getUTCDate();
    if (d < 0) {
        m -= 1;
        const prevLen = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
        d += prevLen;
    }
    if (m < 0) {
        y -= 1;
        m += 12;
    }
    return { y, m, d, decimal: (target - dob) / (DAY * 365.2425) };
}
function ageString(p) {
    if (!p)
        return "—";
    return `${p.y}y ${p.m}m ${p.d}d`;
}
/** "YYYY-MM" → first day of that month, the convention USCIS uses. */
function monthToFirstDay(ym) {
    if (!ym || typeof ym !== "string")
        return "";
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-01` : "";
}
/* ────────────────────────────────────────────────────────────
   CATEGORIES — DV path intentionally excluded; families in the
   diversity lottery face a fiscal-year cliff this tool cannot
   model responsibly, so it points them to counsel instead.
   ──────────────────────────────────────────────────────────── */
const CATEGORIES = {
    fam: {
        label: "A relative filed for our family",
        detail: "Family preference · F1, F2A, F2B, F3, F4",
        mode: "formula",
        statute: "INA 203(h)(1)",
        subs: [
            ["F1", "A U.S. citizen parent filed, and the parent of my child is unmarried (F1)", "F1: Unmarried Sons and Daughters of Citizens"],
            ["F2A", "A green card holder filed for their spouse or child (F2A)", "F2A: Spouses and Children of Permanent Residents"],
            ["F2B", "A green card holder filed for an unmarried adult child (F2B)", "F2B: Unmarried Sons and Daughters (21 years of age or older) of Permanent Residents"],
            ["F3", "A U.S. citizen filed for a married son or daughter (F3)", "F3: Married Sons and Daughters of Citizens"],
            ["F4", "A U.S. citizen filed for a brother or sister (F4)", "F4: Brothers and Sisters of Adult Citizens"],
        ],
    },
    eb: {
        label: "An employer filed for a parent",
        detail: "Employment-based · EB-1 through EB-5",
        mode: "formula",
        statute: "INA 203(h)(1)",
        subs: [
            ["EB1", "EB-1 — priority worker", "1st"],
            ["EB2", "EB-2 — advanced degree or exceptional ability", "2nd"],
            ["EB3", "EB-3 — professionals and skilled workers", "3rd"],
            ["EW", "EB-3 Other Workers — unskilled labour (EW)", "Other Workers"],
            ["EB4", "EB-4 — special immigrant (except religious workers)", "4th"],
            ["SR", "EB-4 Certain Religious Workers (SR)", "Certain Religious Workers"],
            ["E5U", "EB-5 Unreserved — C5, T5, I5, R5, NU, RU", "5th Unreserved (including C5, T5, I5, R5, NU, RU)"],
            ["E5R", "EB-5 Set-Aside — Rural (20%)", "5th Set Aside: Rural (20%)"],
            ["E5H", "EB-5 Set-Aside — High Unemployment (10%)", "5th Set Aside: High Unemployment (10%)"],
            ["E5I", "EB-5 Set-Aside — Infrastructure (2%)", "5th Set Aside: Infrastructure (2%)"],
        ],
    },
    ir: {
        label: "A U.S. citizen parent filed directly for the child",
        detail: "Immediate relative",
        mode: "freeze",
        statute: "INA 201(f)(1)",
        freezeLabel: "When was the Form I-130 filed?",
        freezeHint: "The child's age locks on this date and never moves again.",
    },
    f2a_nat: {
        label: "The green card parent became a citizen",
        detail: "F2A converting to immediate relative",
        mode: "freeze",
        statute: "INA 201(f)(2)",
        freezeLabel: "When did the parent naturalize?",
        freezeHint: "The age locks on the naturalization date — not the petition date.",
    },
    f3_term: {
        label: "The married son or daughter's marriage ended",
        detail: "F3 converting to F1",
        mode: "freeze",
        statute: "INA 201(f)(3)",
        freezeLabel: "When did the marriage legally end?",
        freezeHint: "By death, divorce, or annulment. The age locks on this date.",
    },
    asylee: {
        label: "A parent applied for asylum",
        detail: "Asylee derivative",
        mode: "freeze",
        statute: "INA 208(b)(3)(B)",
        freezeLabel: "When did the parent file Form I-589?",
        freezeHint: "The age locks on the filing date. There is no one-year deadline.",
    },
    refugee: {
        label: "A parent applied as a refugee",
        detail: "Refugee derivative",
        mode: "freeze",
        statute: "INA 207(c)(2)(B)",
        freezeLabel: "When did the parent file the refugee application?",
        freezeHint: "The age locks on the filing date. There is no one-year deadline.",
    },
    other: {
        label: "Something else",
        detail: "DV lottery · VAWA · U · T · work-visa dependents",
        mode: "excluded",
        statute: "—",
    },
};
const COUNTRIES = [
    ["ALL", "All chargeability areas except those listed"],
    ["CHINA", "China — mainland born"],
    ["INDIA", "India"],
    ["MEXICO", "Mexico"],
    ["PHILIPPINES", "Philippines"],
];
const COUNTRY_LABEL = Object.fromEntries(COUNTRIES);
const SOUGHT_ACTIONS_AOS = [
    ["i485", "Filed Form I-485 (the child's own application)"],
    ["ds260", "Submitted Form DS-260, Part I"],
    ["ivfee", "Paid the immigrant visa fee bill to DOS"],
    ["i864", "Paid the Form I-864 review fee to DOS"],
];
const SOUGHT_ACTIONS_CP = [
    ["ds260", "Submitted Form DS-260, Part I"],
    ["ivfee", "Paid the immigrant visa fee bill to DOS"],
    ["i864", "Paid the Form I-864 review fee to DOS"],
    ["i485", "Filed Form I-485 (later abandoned or denied)"],
    ["i824", "Principal filed Form I-824 (following-to-join)"],
];
const POLICY_SHIFT = Date.UTC(2025, 7, 15);
const POLICY_2023 = Date.UTC(2023, 1, 14);
/* ────────────────────────────────────────────────────────────
   VISA BULLETIN LOOKUP
   ──────────────────────────────────────────────────────────── */
function bulletinPrompt({ rowLabel, countryLabel, priorityDate }) {
    return `You are reading the U.S. Department of State Visa Bulletin. Search travel.state.gov for the current bulletin and, if needed, the bulletin archive.

Case:
- Bulletin row, exactly as printed in the chart: "${rowLabel}"
- Chargeability column: ${countryLabel}
- Priority date: ${priorityDate}

CRITICAL: read the cell at the intersection of that exact row and that exact column. The employment chart contains rows that look similar but carry very different cut-off dates — "3rd" and "Other Workers" are separate rows, as are "4th" and "Certain Religious Workers", and as are "5th Unreserved" and each "5th Set Aside" row. Never substitute an adjacent row. If you cannot locate the exact row named above, return null for the dates rather than guessing.

Determine:
1. The month and year of the most recent Visa Bulletin available, and its URL.
2. The Final Action Date cut-off in that cell.
3. The Dates for Filing cut-off in the same cell.
4. Whether this priority date is current under Final Action Dates in that bulletin.
5. If it IS current: search the bulletin archive to identify the EARLIEST month in which the Final Action Date for this cell first reached or passed this priority date. This is the single most important value. Report your confidence honestly.
6. Whether the cut-off for this cell has retrogressed at any point since that first-current month.

Cut-off values may be a date, "C" (current), or "U" (unavailable). Report a date as YYYY-MM-DD, otherwise the literal "C" or "U".

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "row_confirmed": "the exact row heading you read from the chart",
  "bulletin_month": "Month YYYY",
  "bulletin_url": "https://...",
  "final_action_date": "YYYY-MM-DD" | "C" | "U" | null,
  "dates_for_filing": "YYYY-MM-DD" | "C" | "U" | null,
  "is_current": true | false,
  "first_current_month": "YYYY-MM" | null,
  "first_current_confidence": "high" | "medium" | "low",
  "retrogressed_since": true | false | null,
  "note": "one sentence on anything unusual, or an empty string"
}`;
}
async function lookupBulletin({ rowLabel, countryLabel, priorityDate }) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1000,
            messages: [{ role: "user", content: bulletinPrompt({ rowLabel, countryLabel, priorityDate }) }],
            tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
    });
    if (!res.ok)
        throw new Error(`The bulletin service returned ${res.status}.`);
    const data = await res.json();
    const text = (data.content || []).map((i) => (i.type === "text" ? i.text : "")).filter(Boolean).join("\n");
    const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!match)
        throw new Error("The bulletin reading came back unreadable.");
    return JSON.parse(match[0]);
}
/* ────────────────────────────────────────────────────────────
   CORE ENGINE
   ──────────────────────────────────────────────────────────── */
function evaluate(f) {
    const cat = f.category ? CATEGORIES[f.category] : null;
    if (!cat)
        return { incomplete: true, missing: "a category above" };
    const flags = [];
    const push = (tier, title, body) => flags.push({ tier, title, body });
    if (cat.mode === "excluded") {
        return {
            excluded: true,
            flags: [
                {
                    tier: "bar",
                    title: "This calculator can't run these cases — on purpose",
                    body: "Diversity Visa cases die at midnight on 30 September of the program year no matter what any age calculation says, so a CSPA number without a processing-time judgment is misleading. VAWA, U, and T derivatives have their own age-out rules that use different trigger dates. And dependents on work visas (H-4, L-2, E-2) have no age-out protection at all. In each of these, a wrong number is worse than no number.",
                },
                {
                    tier: "extraordinary",
                    title: "What to do instead",
                    body: "For DV cases: contact an immigration attorney immediately after selection — the timeline is the whole case. For VAWA, U, and T: ask counsel which age-out provision governs, because it is not this one. For work-visa dependents approaching 21: ask about a change of status (often F-1) well before the birthday.",
                },
            ],
        };
    }
    const dob = parseDate(f.dob);
    if (dob == null)
        return { incomplete: true, missing: "the child's date of birth" };
    if (dob > todayUTC())
        return { error: "The date of birth is in the future. Check the entry." };
    const birthday21 = addYears(dob, 21);
    /* ── Freeze categories ── */
    if (cat.mode === "freeze") {
        const freeze = parseDate(f.freezeDate);
        if (freeze == null)
            return { incomplete: true, missing: "the date the age locks on" };
        const parts = ageParts(dob, freeze);
        const under21 = freeze < birthday21;
        if (f.married) {
            push("bar", "Marriage ends the protection", "CSPA protects unmarried children only. If the child marries at any point before the green card is granted, the benefit is lost no matter what the calculated age is.");
        }
        if (f.category === "ir") {
            push("note", "No one-year deadline here", "Immediate relatives are exempt from the sought-to-acquire requirement. There is no clock to miss.");
        }
        if (f.category === "f2a_nat" && under21) {
            push("extraordinary", "Staying in the old line is sometimes faster", "Naturalization converts the case to immediate relative, which is usually the faster line. But for Mexico and the Philippines, the F2B line has at times moved ahead of it. The family can opt out in writing and stay in F2B — an election that is hard to unwind. Compare both Visa Bulletin lines before choosing.");
        }
        if (!under21) {
            push("extraordinary", "Aged out — but check for another petition first", "Before treating this as final, check whether a different petition reaches the same child with a better lock-in date, or whether the child qualifies independently in another category.");
        }
        return {
            mode: "freeze", cat, dob, birthday21,
            referenceDate: freeze, cspaAge: parts, realAgeAtRef: parts,
            pendingDays: 0, under21,
            qualifies: under21 && !f.married,
            conditional: false,
            flags,
        };
    }
    /* ── Preference formula ── */
    const receipt = parseDate(f.receiptDate);
    const approval = parseDate(f.approvalDate);
    if (receipt == null)
        return { incomplete: true, missing: "the petition receipt date" };
    if (approval == null)
        return { incomplete: true, missing: "the petition approval date" };
    if (approval < receipt)
        return { error: "The approval date is earlier than the receipt date. Check both." };
    const fad = parseDate(f.fadDate);
    if (fad == null)
        return { incomplete: true, missing: "the date the priority date became current — use the lookup above or enter it by hand", projectable: true };
    const pendingDays = diffDays(approval, receipt);
    const i485 = parseDate(f.i485Date);
    let regime, chartName, chartDate;
    if (f.track === "cp") {
        regime = "State Department — Final Action Dates, unchanged since CSPA's enactment";
        chartName = "Final Action Dates";
        chartDate = fad;
    }
    else if (i485 != null && i485 >= POLICY_2023 && i485 < POLICY_SHIFT) {
        const dff = parseDate(f.dffDate);
        if (dff != null) {
            regime = "USCIS policy of 14 Feb 2023 (grandfathered)";
            chartName = "Dates for Filing";
            chartDate = dff;
        }
        else {
            regime = "USCIS policy of 14 Feb 2023 (grandfathered)";
            chartName = "Final Action Dates";
            chartDate = fad;
        }
    }
    else if (i485 != null && i485 >= POLICY_SHIFT) {
        regime = "USCIS policy of 15 Aug 2025";
        chartName = "Final Action Dates";
        chartDate = fad;
    }
    else if (i485 != null && i485 < POLICY_2023) {
        regime = "USCIS policy in effect before 14 Feb 2023";
        chartName = "Final Action Dates";
        chartDate = fad;
    }
    else {
        regime = "USCIS policy of 15 Aug 2025 (no I-485 filed yet — current rule assumed)";
        chartName = "Final Action Dates";
        chartDate = fad;
    }
    const availabilityDate = Math.max(chartDate, approval);
    const cappedByApproval = approval > chartDate;
    const referenceDate = availabilityDate - pendingDays * DAY;
    const cspaAge = ageParts(dob, referenceDate);
    const realAgeAtRef = ageParts(dob, availabilityDate);
    const under21 = referenceDate < birthday21;
    const sought = parseDate(f.soughtDate);
    const soughtDeadline = addYears(availabilityDate, 1);
    const soughtOk = sought != null && sought <= soughtDeadline;
    const soughtPending = sought == null && soughtDeadline > todayUTC();
    const marginDays = diffDays(birthday21, referenceDate);
    if (f.married) {
        push("bar", "Marriage ends the protection", "CSPA protects unmarried children only. Marriage at any point before the green card is granted forfeits the benefit permanently, whatever the calculated age. For employment-based and F2 cases there is no recovery.");
    }
    if (f.retrogressed) {
        push("extraordinary", "Retrogression makes this a month-by-month question", "When the date becomes current and then moves backward before a full year runs, the family gets a fresh one-year window at the next availability — and the date used for the age calculation may shift with it. If extraordinary circumstances existed during the first window, the earlier date may still be used, which is usually better. The figure above assumes one uninterrupted availability; a lawyer should walk the bulletin months for this one.");
    }
    if (sought != null && !soughtOk) {
        push("extraordinary", "The one-year step looks late", `The action is dated ${fmt(sought)} against a deadline of ${fmt(soughtDeadline)}. USCIS can excuse a late step for extraordinary circumstances — serious illness, a death in the family, bad legal advice, or a policy change — where the delay was beyond the family's control and reasonable in length. That is a discretionary judgment, not a calculation.`);
    }
    else if (sought == null && !soughtPending && under21) {
        push("extraordinary", "The one-year window closed with nothing entered", `The deadline was ${fmt(soughtDeadline)}. First, check whether a step was in fact taken — an I-485 filing, a DS-260 submission, a fee payment all count, and families often don't realize a payment already satisfied it. If truly nothing was done in time, the case depends on the extraordinary circumstances exception. Gather documentation of what prevented action before seeing counsel.`);
    }
    else if (f.extraordinary) {
        push("extraordinary", "Extraordinary circumstances asserted", "Where accepted, USCIS may excuse the one-year requirement, and in retrogression cases may calculate the age from the earlier availability date. Both need documentary proof and a favorable exercise of discretion.");
    }
    if (!under21) {
        push("extraordinary", "Keeping the old priority date is narrower than people hope", "The law converts an aged-out child to the appropriate adult category with the original priority date — but the Supreme Court (Scialabba v. Cuellar de Osorio, 2014) confined that largely to F2A converting to F2B. A child on an F3 or F4 petition generally cannot carry the date into a new petition. Don't assume the years already waited are preserved.");
    }
    if (under21 && Math.abs(marginDays) <= 180) {
        push("extraordinary", `Thin margin — ${marginDays} days under the line`, "A correction to any input can flip this result. Reverify the receipt and approval dates against the Form I-797, and the bulletin month, before relying on it.");
    }
    if (f.crossChargeable) {
        push("extraordinary", "A spouse's birth country may move the date by years", "Where a spouse was born in a different country, the case may be charged there instead. For India or China cases especially, this can pull the availability date years earlier — which changes the CSPA age. Run the numbers both ways.");
    }
    if (f.priorPetition) {
        push("extraordinary", "An earlier petition may give a better answer", "Where more than one petition reaches the child, the most favorable one may be used. Identify every filing on record before settling on a number.");
    }
    if (f.sub === "F2A" && !f.naturalized) {
        push("note", "If the parent naturalizes, the rule changes", "The age would then freeze on the naturalization date instead. Come back and re-run this as “the green card parent became a citizen.”");
    }
    if (f.sub === "EW") {
        push("extraordinary", "Other Workers is its own bulletin row — years behind EB-3", "The unskilled Other Workers line has at times sat more than two years behind Professionals and Skilled Workers for the same country. Using the wrong row makes the child look younger than the law says they are. Confirm from the I-140 and the certified ETA-9089 which row governs — it turns on whether the job requires two years of training or experience.");
    }
    if (f.sub === "SR" || f.sub === "EB4") {
        push("note", "EB-4 and Certain Religious Workers are separate rows", "Certain Religious Workers has gone entirely unavailable while the general EB-4 line still had a date. Check which line the case sits on.");
    }
    if (f.sub === "E5R" || f.sub === "E5H" || f.sub === "E5I") {
        push("note", "Set-aside rows move independently of EB-5 Unreserved", "The Rural, High Unemployment, and Infrastructure lines have stayed current while Unreserved was backlogged for China and India. A set-aside case is read on its own row.");
    }
    if (f.track === "cp" && f.soughtAction === "i485") {
        push("note", "An abandoned I-485 still counts", "The child's own I-485 satisfies the one-year requirement even if later denied or abandoned in favor of consular processing. The parent's I-485, by contrast, does nothing for the child — only a Form I-824 does.");
    }
    if (f.track === "aos" && i485 != null && i485 >= POLICY_2023 && i485 < POLICY_SHIFT) {
        push("note", "Grandfathered under the 2023 policy", "Applications pending before 15 Aug 2025 keep the more generous calculation. This was never available consular-side, so an identical case abroad comes out differently.");
    }
    if (cappedByApproval) {
        push("note", "Availability capped at the approval date", `The priority date was current before the petition was approved, so the visa could not become available until ${fmt(approval)}. That later date governs.`);
    }
    if (f.fadSource === "fetched") {
        if (f.lookupConfidence === "low" || f.lookupConfidence === "medium") {
            push("extraordinary", `The availability date came from an archive search — ${f.lookupConfidence} confidence`, `It was read from the Visa Bulletin archive, not from a verified record. Open the bulletin for ${fmt(chartDate)} and confirm the cell yourself before this number leaves the screen.`);
        }
        else {
            push("note", "Availability date came from the bulletin lookup", `Read from the Visa Bulletin${f.lookupBulletinMonth ? ` as of ${f.lookupBulletinMonth}` : ""}. Confirm it against the published bulletin before relying on it.`);
        }
    }
    push("note", "How pending time was counted", "From the petition receipt date to the approval date. Time in administrative review, including motions and appeals to USCIS, counts; time evaluating consular returns does not.");
    return {
        mode: "formula", cat, dob, birthday21,
        referenceDate, availabilityDate, chartName, chartDate, regime,
        cspaAge, realAgeAtRef, pendingDays, under21, marginDays,
        soughtDeadline, soughtOk, sought, soughtPending,
        qualifies: under21 && !f.married && soughtOk,
        conditional: under21 && !f.married && soughtPending,
        flags,
    };
}
/* ────────────────────────────────────────────────────────────
   COMPONENTS
   ──────────────────────────────────────────────────────────── */
function ThresholdRule({ r }) {
    const cspaY = r.cspaAge ? r.cspaAge.decimal : 0;
    const realY = r.realAgeAtRef ? r.realAgeAtRef.decimal : cspaY;
    const lo = Math.min(cspaY, realY, 21) - 1.2;
    const hi = Math.max(cspaY, realY, 21) + 1.2;
    const span = hi - lo;
    const pos = (v) => ((v - lo) / span) * 100;
    const linePos = pos(21);
    const cspaPos = pos(cspaY);
    const realPos = pos(realY);
    const pulled = Math.abs(realPos - cspaPos) > 0.4;
    return (React.createElement("div", { className: "cspa-rule" },
        React.createElement("div", { className: "cspa-rule-head" },
            React.createElement("span", { className: "cspa-eyebrow" }, "The 21-year line"),
            React.createElement("span", { className: "cspa-rule-legend" },
                React.createElement("i", { className: "cspa-sw cspa-sw-in" }),
                " under 21",
                React.createElement("i", { className: "cspa-sw cspa-sw-out" }),
                " 21 or over")),
        React.createElement("div", { className: "cspa-track" },
            React.createElement("div", { className: "cspa-zone-in", style: { width: `${linePos}%` } }),
            React.createElement("div", { className: "cspa-zone-out", style: { left: `${linePos}%`, width: `${100 - linePos}%` } }),
            React.createElement("div", { className: "cspa-line", style: { left: `${linePos}%` } },
                React.createElement("span", { className: "cspa-line-tag" }, "21 \u00B7 0 \u00B7 0")),
            pulled && (React.createElement("div", { className: "cspa-pull", style: { left: `${Math.min(cspaPos, realPos)}%`, width: `${Math.abs(realPos - cspaPos)}%` } })),
            pulled && (React.createElement("div", { className: "cspa-marker cspa-marker-ghost", style: { left: `${realPos}%` } },
                React.createElement("span", { className: "cspa-marker-dot" }))),
            React.createElement("div", { className: `cspa-marker cspa-marker-live ${r.under21 ? "is-in" : "is-out"}`, style: { left: `${cspaPos}%` } },
                React.createElement("span", { className: "cspa-marker-dot" }))),
        React.createElement("div", { className: "cspa-rule-foot" }, pulled ? (React.createElement(React.Fragment, null,
            React.createElement("span", null,
                "actual age ",
                React.createElement("b", null, ageString(r.realAgeAtRef))),
            React.createElement("span", { className: "cspa-pull-label" },
                "\u2190 pulled back ",
                r.pendingDays.toLocaleString(),
                " days"),
            React.createElement("span", null,
                "CSPA age ",
                React.createElement("b", null, ageString(r.cspaAge))))) : (React.createElement("span", null,
            "age locked at ",
            React.createElement("b", null, ageString(r.cspaAge)))))));
}
function Projection({ dob, receiptDate, approvalDate }) {
    const d = parseDate(dob);
    const rec = parseDate(receiptDate);
    const app = parseDate(approvalDate);
    if (d == null || rec == null || app == null || app < rec)
        return null;
    const today = todayUTC();
    const b21 = addYears(d, 21);
    const pendingDays = diffDays(app, rec);
    const deadline = b21 + pendingDays * DAY;
    const daysLeft = diffDays(deadline, today);
    const ageNow = ageParts(d, today);
    const daysTo21 = diffDays(b21, today);
    let tier, word;
    if (daysLeft < 0) {
        tier = "out";
        word = "The window has passed";
    }
    else if (daysLeft <= 365) {
        tier = "urgent";
        word = "Under a year of protection left";
    }
    else if (daysLeft <= 730) {
        tier = "watch";
        word = "Worth checking every bulletin";
    }
    else {
        tier = "clear";
        word = "Comfortable margin, for now";
    }
    return (React.createElement("div", { className: `cspa-proj cspa-proj-${tier}` },
        React.createElement("div", { className: "cspa-proj-head" },
            React.createElement("span", { className: "cspa-eyebrow" }, "Protection window"),
            React.createElement("span", { className: "cspa-proj-word" }, word)),
        React.createElement("div", { className: "cspa-proj-main" },
            React.createElement("div", { className: "cspa-proj-cell" },
                React.createElement("span", { className: "cspa-proj-k" }, "The visa must become available before"),
                React.createElement("span", { className: "cspa-proj-v" }, fmt(deadline))),
            React.createElement("div", { className: "cspa-proj-cell" },
                React.createElement("span", { className: "cspa-proj-k" }, daysLeft >= 0 ? "Which is" : "Which passed"),
                React.createElement("span", { className: "cspa-proj-v" },
                    Math.abs(daysLeft).toLocaleString(),
                    " days ",
                    daysLeft >= 0 ? "from today" : "ago"))),
        React.createElement("div", { className: "cspa-proj-sub" },
            React.createElement("span", null,
                "Age today ",
                React.createElement("b", null, ageString(ageNow))),
            React.createElement("span", null,
                "Turns 21 in ",
                React.createElement("b", null, daysTo21 > 0 ? `${daysTo21.toLocaleString()} days` : "— already 21")),
            React.createElement("span", null,
                "Pending-time credit ",
                React.createElement("b", null,
                    pendingDays.toLocaleString(),
                    " days"))),
        React.createElement("p", { className: "cspa-proj-note" }, daysLeft >= 0 ? (React.createElement(React.Fragment, null,
            "The petition's pending time buys exactly ",
            pendingDays.toLocaleString(),
            " days past the 21st birthday on ",
            fmt(b21),
            " \u2014 nothing more. If the Final Action Date for this row reaches the priority date in a Visa Bulletin month beginning before ",
            fmt(deadline),
            ", the child stays protected, provided a qualifying step is taken within one year. Check the lookup each month a new bulletin publishes.")) : (React.createElement(React.Fragment, null,
            "On these inputs the window closed on ",
            fmt(deadline),
            ". Before treating that as final, check: the grandfathered 2023 policy if an I-485 was pending before 15 Aug 2025; whether an earlier first-current month exists in the retrogression history; cross-chargeability through a spouse's birth country; and any earlier petition with a better priority date. Any one of these can reopen the case.")))));
}
function Field({ label, hint, children }) {
    return (React.createElement("label", { className: "cspa-field" },
        React.createElement("span", { className: "cspa-label" }, label),
        children,
        hint && React.createElement("span", { className: "cspa-hint" }, hint)));
}
function DateInput({ value, onChange }) {
    return React.createElement("input", { type: "date", className: "cspa-input", value: value || "", onChange: (e) => onChange(e.target.value) });
}
function Check({ checked, onChange, children }) {
    return (React.createElement("label", { className: "cspa-check" },
        React.createElement("input", { type: "checkbox", checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
        React.createElement("span", null, children)));
}
function Row({ k, v, mono = true, strong = false }) {
    return (React.createElement("div", { className: "cspa-row" },
        React.createElement("span", { className: "cspa-row-k" }, k),
        React.createElement("span", { className: `cspa-row-v ${mono ? "mono" : ""} ${strong ? "strong" : ""}` }, v)));
}
const TIER_META = {
    bar: { mark: "■", word: "Stops the case" },
    extraordinary: { mark: "‡", word: "Needs a human judgment" },
    note: { mark: "—", word: "Good to know" },
};
function Flag({ f }) {
    const meta = TIER_META[f.tier];
    return (React.createElement("div", { className: `cspa-flag cspa-flag-${f.tier}` },
        React.createElement("div", { className: "cspa-flag-head" },
            React.createElement("span", { className: "cspa-flag-mark" }, meta.mark),
            React.createElement("span", { className: "cspa-flag-word" }, meta.word)),
        React.createElement("div", { className: "cspa-flag-title" }, f.title),
        React.createElement("p", { className: "cspa-flag-body" }, f.body)));
}
/** Step shell: numbered, gated, with a done tick. */
function Step({ n, title, done, open, children, aside }) {
    if (!open)
        return null;
    return (React.createElement("section", { className: `cspa-step ${done ? "is-done" : ""}` },
        React.createElement("div", { className: "cspa-step-head" },
            React.createElement("span", { className: "cspa-step-n" }, done ? "✓" : n),
            React.createElement("h2", { className: "cspa-step-t" }, title),
            aside && React.createElement("span", { className: "cspa-cite" }, aside)),
        React.createElement("div", { className: "cspa-step-body" }, children)));
}
function cutoffText(v) {
    if (!v)
        return "—";
    if (v === "C")
        return "C · current";
    if (v === "U")
        return "U · unavailable";
    const ms = parseDate(v);
    return ms == null ? String(v) : fmt(ms);
}
function BulletinLookup({ rowLabel, country, setCountry, priorityDate, setPriorityDate, state, run, apply }) {
    const d = state.data;
    const rowMismatch = d && d.row_confirmed && String(d.row_confirmed).toLowerCase().trim() !== String(rowLabel).toLowerCase().trim();
    return (React.createElement("div", { className: "cspa-lookup" },
        React.createElement("div", { className: "cspa-rowtarget" },
            React.createElement("span", { className: "cspa-eyebrow" }, "Reading row"),
            React.createElement("span", { className: "cspa-rowtarget-v" },
                rowLabel,
                " ",
                React.createElement("span", { className: "cspa-rowtarget-c" },
                    "\u00B7 ",
                    COUNTRY_LABEL[country]))),
        React.createElement("div", { className: "cspa-grid" },
            React.createElement(Field, { label: "Country of birth", hint: "Chargeability follows birth, not citizenship or residence." },
                React.createElement("select", { className: "cspa-select", value: country, onChange: (e) => setCountry(e.target.value) }, COUNTRIES.map(([v, l]) => React.createElement("option", { key: v, value: v }, l)))),
            React.createElement(Field, { label: "Priority date", hint: "Printed on the Form I-797 \u2014 not the receipt date." },
                React.createElement(DateInput, { value: priorityDate, onChange: setPriorityDate }))),
        React.createElement("button", { className: "cspa-lookup-go", onClick: run, disabled: state.status === "loading" || !priorityDate }, state.status === "loading" ? "Reading the bulletin…" : "Read the Visa Bulletin"),
        state.status === "loading" && (React.createElement("div", { className: "cspa-lookup-wait" },
            React.createElement("span", { className: "cspa-pulse" }),
            "Searching travel.state.gov for the current bulletin, then walking the archive back to find the month this priority date first became current. This takes a moment.")),
        state.status === "error" && (React.createElement("div", { className: "cspa-lookup-err" },
            state.message,
            " Enter the availability date by hand below instead.")),
        state.status === "done" && d && (React.createElement("div", { className: "cspa-lookup-out" },
            React.createElement("div", { className: "cspa-lookup-head" },
                React.createElement("span", { className: "cspa-eyebrow" }, "Visa Bulletin"),
                React.createElement("span", { className: "cspa-lookup-month" }, d.bulletin_month || "current")),
            rowMismatch && (React.createElement("div", { className: "cspa-lookup-err", style: { marginTop: 0, marginBottom: 10 } },
                "Row mismatch: you asked for ",
                React.createElement("b", null, rowLabel),
                " but the bulletin was read as ",
                React.createElement("b", null, d.row_confirmed),
                ". These rows carry different dates. Don't use this result \u2014 open the bulletin and read the cell yourself.")),
            React.createElement("div", { className: "cspa-ledger", style: { marginTop: 0 } },
                React.createElement(Row, { k: `${d.row_confirmed || rowLabel} · ${COUNTRY_LABEL[country]}`, v: "" }),
                React.createElement(Row, { k: "Final Action Date", v: cutoffText(d.final_action_date) }),
                React.createElement(Row, { k: "Dates for Filing", v: cutoffText(d.dates_for_filing) }),
                React.createElement(Row, { k: "This priority date is", v: d.is_current ? "current" : "not yet current", strong: true }),
                d.first_current_month && (React.createElement(Row, { k: "First became current", v: `${d.first_current_month} · ${d.first_current_confidence} confidence` })),
                d.retrogressed_since === true && React.createElement(Row, { k: "Retrogressed since", v: "yes", strong: true })),
            d.note ? React.createElement("p", { className: "cspa-lookup-note" }, d.note) : null,
            d.first_current_month ? (React.createElement("button", { className: "cspa-lookup-apply", onClick: apply },
                "Use ",
                monthToFirstDay(d.first_current_month),
                " as the availability date")) : (React.createElement("div", { className: "cspa-lookup-err", style: { marginTop: 10 } }, d.is_current
                ? "The archive search couldn't pin down the first-current month. Enter it by hand below."
                : "This priority date isn't current yet — so no CSPA age can be locked in. The panel below shows the deadline it must beat.")),
            d.bulletin_url && (React.createElement("a", { className: "cspa-lookup-src", href: d.bulletin_url, target: "_blank", rel: "noreferrer" }, "Open the bulletin and verify \u2197"))))));
}
/* ────────────────────────────────────────────────────────────
   ATTORNEY REPORT — one shared data builder feeds both the
   printable HTML document and the PDF, so the two can never
   drift apart in content.
   ──────────────────────────────────────────────────────────── */
function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildReportData(f, r, meta) {
    const { cat, catEntry, extraordinaryCount } = meta;
    const today = fmt(todayUTC());
    const params = [];
    params.push(["Category", `${cat.label}${catEntry ? ` — ${catEntry[1]}` : ""}`]);
    params.push(["Governing statute", cat.statute]);
    if (r.mode === "formula") {
        params.push(["Processing", f.track === "cp" ? "Consular processing (abroad)" : "Adjustment of status (I-485)"]);
        params.push(["Chargeability area", COUNTRY_LABEL[f.country] || ""]);
        if (f.priorityDate)
            params.push(["Priority date", fmt(parseDate(f.priorityDate))]);
    }
    params.push(["Child's date of birth", fmt(r.dob)]);
    params.push(["21st birthday", fmt(r.birthday21)]);
    params.push(["Child is married", f.married ? "YES — see stops below" : "No"]);
    if (r.mode === "formula") {
        params.push(["Petition receipt date", fmt(parseDate(f.receiptDate))]);
        params.push(["Petition approval date", fmt(parseDate(f.approvalDate))]);
        if (f.i485Date)
            params.push(["I-485 filed", fmt(parseDate(f.i485Date))]);
        if (f.dffDate)
            params.push(["Current under Dates for Filing", fmt(parseDate(f.dffDate))]);
        params.push(["Availability date used", fmt(r.chartDate)]);
        params.push(["Availability date source",
            f.fadSource === "fetched"
                ? `Visa Bulletin lookup, ${f.lookupConfidence || "unknown"} confidence — UNVERIFIED, confirm against the published bulletin`
                : "Entered by hand from the Visa Bulletin"]);
        if (f.soughtDate) {
            const act = (f.track === "aos" ? SOUGHT_ACTIONS_AOS : SOUGHT_ACTIONS_CP).find((a) => a[0] === f.soughtAction);
            params.push(["Sought-to-acquire step", act ? act[1] : f.soughtAction]);
            params.push(["Step taken on", fmt(parseDate(f.soughtDate))]);
        }
        const circ = [];
        if (f.retrogressed)
            circ.push("visa retrogression reported");
        if (f.extraordinary)
            circ.push("extraordinary circumstances asserted");
        if (f.crossChargeable)
            circ.push("possible cross-chargeability (spouse born elsewhere)");
        if (f.priorPetition)
            circ.push("an earlier petition may exist");
        params.push(["Circumstances noted", circ.length ? circ.join("; ") : "none reported"]);
    }
    else {
        params.push([cat.freezeLabel || "Age locked on", fmt(r.referenceDate)]);
    }
    const calc = [];
    if (r.mode === "formula") {
        calc.push(["Chart applied", r.chartName]);
        calc.push(["Governing policy", r.regime]);
        calc.push(["Visa became available", fmt(r.availabilityDate)]);
        calc.push(["Actual age on that date", ageString(r.realAgeAtRef)]);
        calc.push(["Petition pending time subtracted", `${r.pendingDays.toLocaleString()} days`]);
        calc.push(["One-year deadline", fmt(r.soughtDeadline)]);
        calc.push(["Qualifying step taken in time",
            r.sought == null ? (r.soughtPending ? "Not yet — clock still open" : "Not entered — deadline passed") : r.soughtOk ? "Yes" : "No"]);
    }
    else {
        calc.push(["Age locked on", fmt(r.referenceDate)]);
        calc.push(["Pending-time subtraction", "Not applicable in this category"]);
    }
    const verdict = r.qualifies
        ? { cls: "in", text: "Protected as a child on these inputs" }
        : r.conditional
            ? { cls: "cond", text: `Protected IF a qualifying step is taken by ${fmt(r.soughtDeadline)}` }
            : r.under21
                ? { cls: "out", text: "Under 21, but a listed condition defeats the benefit" }
                : { cls: "out", text: "Aged out on these inputs" };
    return {
        today,
        cspaAge: ageString(r.cspaAge),
        verdict,
        params,
        calc,
        total: ["CSPA age", ageString(r.cspaAge)],
        bars: r.flags.filter((x) => x.tier === "bar"),
        extras: r.flags.filter((x) => x.tier === "extraordinary"),
        notes: r.flags.filter((x) => x.tier === "note"),
        extraordinaryCount,
        disclaimer: "This document is a self-prepared estimate generated by an online calculator. It is not legal advice, not a USCIS or Department of State determination, and not a substitute for review of the underlying records (Forms I-797, I-130/I-140, the relevant Visa Bulletin months, and any filing receipts). Items listed as questions for the attorney turn on discretion or on facts outside the arithmetic. If the availability date is marked UNVERIFIED, it was read from a Visa Bulletin archive search and must be confirmed against the published bulletin before any reliance.",
        stamp: "Child Status Protection Act · 8 U.S.C. § 1151(f), 1153(h) · Self-prepared estimate for attorney review",
        genLine: `Prepared ${today} · All dates below were entered or fetched by the family, not verified by counsel`,
        extrasHeading: `Questions for the attorney (${extraordinaryCount} item${extraordinaryCount === 1 ? "" : "s"} requiring judgment)`,
    };
}
function buildReportHTML(f, r, meta) {
    const d = buildReportData(f, r, meta);
    const line = ([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`;
    const flagBlock = (items, cls, heading) => items.length
        ? `<h2>${esc(heading)}</h2>` +
            items.map((x) => `<div class="flag ${cls}"><div class="ft">${esc(x.title)}</div><p>${esc(x.body)}</p></div>`).join("")
        : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CSPA Age Estimate — ${esc(d.today)}</title>
<style>
  @page { size: letter; margin: 0.75in; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 0; padding: 24px; max-width: 7.5in; }
  .head { border-bottom: 3px double #111; padding-bottom: 10px; margin-bottom: 18px; }
  .stamp { font-family: 'Courier New', monospace; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: #555; }
  h1 { font-size: 20px; margin: 6px 0 2px; }
  .gen { font-size: 11px; color: #555; }
  h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; border-bottom: 1px solid #999; padding-bottom: 3px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  td.k { width: 46%; color: #444; }
  td.v { font-family: 'Courier New', monospace; font-size: 11.5px; }
  tr.total td { border-top: 2px solid #111; border-bottom: 2px solid #111; font-weight: 700; }
  .verdict { border: 2px solid #111; padding: 10px 12px; margin: 14px 0; font-size: 14px; font-weight: 700; }
  .verdict.in { border-color: #0D7A72; color: #0D7A72; }
  .verdict.cond { border-color: #B07818; color: #8a5c10; }
  .verdict.out { border-color: #B3261E; color: #B3261E; }
  .flag { border-left: 4px solid #999; padding: 6px 10px; margin: 8px 0; font-size: 11.5px; }
  .flag.bar { border-left-color: #B3261E; }
  .flag.extra { border-left-color: #B07818; }
  .flag .ft { font-weight: 700; margin-bottom: 2px; }
  .flag p { margin: 0; line-height: 1.45; color: #333; }
  .notes-area { margin-top: 22px; }
  .notes-line { border-bottom: 1px solid #bbb; height: 26px; }
  .disclaimer { margin-top: 22px; padding-top: 10px; border-top: 1px solid #999; font-size: 10.5px; line-height: 1.5; color: #555; }
  .sig { display: flex; gap: 40px; margin-top: 28px; font-size: 11px; }
  .sig div { flex: 1; border-top: 1px solid #111; padding-top: 4px; }
  @media print { body { padding: 0; } }
</style></head><body>
<div class="head">
  <div class="stamp">${esc(d.stamp)}</div>
  <h1>CSPA Age Estimate</h1>
  <div class="gen">${esc(d.genLine)}</div>
</div>
<div class="verdict ${d.verdict.cls}">CSPA age ${esc(d.cspaAge)} — ${esc(d.verdict.text)}</div>
<h2>Case parameters as entered</h2>
<table>${d.params.map(line).join("")}</table>
<h2>Calculation</h2>
<table>${d.calc.map(line).join("")}<tr class="total"><td class="k">${esc(d.total[0])}</td><td class="v">${esc(d.total[1])}</td></tr></table>
${flagBlock(d.bars, "bar", "Conditions that stop the case")}
${flagBlock(d.extras, "extra", d.extrasHeading)}
${flagBlock(d.notes, "note", "Additional notes")}
<div class="notes-area">
  <h2>Attorney's notes</h2>
  <div class="notes-line"></div><div class="notes-line"></div><div class="notes-line"></div>
  <div class="notes-line"></div><div class="notes-line"></div>
</div>
<div class="sig">
  <div>Prepared by (family member)</div>
  <div>Reviewed by (attorney)</div>
  <div>Date reviewed</div>
</div>
<div class="disclaimer">${esc(d.disclaimer)}</div>
</body></html>`;
}
/* PDF renderer: consumes the same data via a jsPDF instance.
   Letter, 54pt margins, tracked cursor, explicit page breaks. */
function renderReportPDF(doc, d) {
    const W = 612, H = 792, M = 54, R = W - M;
    const COLORS = {
        in: [13, 122, 114], cond: [138, 92, 16], out: [179, 38, 30],
        ink: [17, 17, 17], gray: [85, 85, 85], mid: [68, 68, 68], rule: [153, 153, 153],
        bar: [179, 38, 30], extra: [176, 120, 24], note: [153, 153, 153],
    };
    let y = M;
    const need = (h) => { if (y + h > H - M - 24) {
        doc.addPage();
        y = M;
    } };
    const setC = (c) => { doc.setTextColor(c[0], c[1], c[2]); };
    const setD = (c) => { doc.setDrawColor(c[0], c[1], c[2]); };
    // Header
    doc.setFont("courier", "normal");
    doc.setFontSize(7);
    setC(COLORS.gray);
    doc.text(d.stamp.toUpperCase(), M, y);
    y += 14;
    doc.setFont("times", "bold");
    doc.setFontSize(18);
    setC(COLORS.ink);
    doc.text("CSPA Age Estimate", M, y);
    y += 13;
    doc.setFont("times", "normal");
    doc.setFontSize(9);
    setC(COLORS.gray);
    doc.text(d.genLine, M, y);
    y += 8;
    setD(COLORS.ink);
    doc.setLineWidth(1.2);
    doc.line(M, y, R, y);
    doc.setLineWidth(0.6);
    doc.line(M, y + 2.5, R, y + 2.5);
    y += 16;
    // Verdict box
    const vc = COLORS[d.verdict.cls] || COLORS.ink;
    const vText = `CSPA age ${d.cspaAge} — ${d.verdict.text}`;
    doc.setFont("times", "bold");
    doc.setFontSize(12);
    const vLines = doc.splitTextToSize(vText, R - M - 24);
    const vh = vLines.length * 14 + 16;
    need(vh + 10);
    setD(vc);
    doc.setLineWidth(1.5);
    doc.rect(M, y, R - M, vh);
    setC(vc);
    doc.text(vLines, M + 12, y + 18);
    y += vh + 16;
    const heading = (t) => {
        need(30);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        setC(COLORS.ink);
        doc.text(t.toUpperCase(), M, y);
        y += 4;
        setD(COLORS.rule);
        doc.setLineWidth(0.6);
        doc.line(M, y, R, y);
        y += 12;
    };
    const kvRow = ([k, v], strong) => {
        doc.setFont("times", "normal");
        doc.setFontSize(9.5);
        const kLines = doc.splitTextToSize(String(k), 235);
        doc.setFont("courier", strong ? "bold" : "normal");
        doc.setFontSize(8.5);
        const vLines2 = doc.splitTextToSize(String(v), R - M - 260);
        const rh = Math.max(kLines.length, vLines2.length) * 11 + 5;
        need(rh);
        if (strong) {
            setD(COLORS.ink);
            doc.setLineWidth(1);
            doc.line(M, y - 3, R, y - 3);
        }
        doc.setFont("times", "normal");
        doc.setFontSize(9.5);
        setC(COLORS.mid);
        doc.text(kLines, M, y + 6);
        doc.setFont("courier", strong ? "bold" : "normal");
        doc.setFontSize(8.5);
        setC(COLORS.ink);
        doc.text(vLines2, M + 250, y + 6);
        y += rh;
        setD(strong ? COLORS.ink : [221, 221, 221]);
        doc.setLineWidth(strong ? 1 : 0.4);
        doc.line(M, y, R, y);
        y += 5;
    };
    heading("Case parameters as entered");
    d.params.forEach((row) => kvRow(row, false));
    y += 6;
    heading("Calculation");
    d.calc.forEach((row) => kvRow(row, false));
    kvRow(d.total, true);
    y += 6;
    const flagBlock = (items, color, head) => {
        if (!items.length)
            return;
        heading(head);
        items.forEach((x) => {
            doc.setFont("times", "bold");
            doc.setFontSize(9.5);
            const tLines = doc.splitTextToSize(x.title, R - M - 20);
            doc.setFont("times", "normal");
            doc.setFontSize(9);
            const bLines = doc.splitTextToSize(x.body, R - M - 20);
            const bh = tLines.length * 11 + bLines.length * 10.5 + 14;
            need(bh);
            setD(color);
            doc.setLineWidth(2.5);
            doc.line(M + 1, y, M + 1, y + bh - 8);
            doc.setFont("times", "bold");
            doc.setFontSize(9.5);
            setC(COLORS.ink);
            doc.text(tLines, M + 12, y + 8);
            doc.setFont("times", "normal");
            doc.setFontSize(9);
            setC([51, 51, 51]);
            doc.text(bLines, M + 12, y + 8 + tLines.length * 11);
            y += bh;
        });
        y += 4;
    };
    flagBlock(d.bars, COLORS.bar, "Conditions that stop the case");
    flagBlock(d.extras, COLORS.extra, d.extrasHeading);
    flagBlock(d.notes, COLORS.note, "Additional notes");
    // Attorney's notes
    need(130);
    heading("Attorney's notes");
    setD([187, 187, 187]);
    doc.setLineWidth(0.5);
    for (let i = 0; i < 5; i++) {
        y += 20;
        doc.line(M, y, R, y);
    }
    y += 26;
    // Signature block
    need(50);
    const colW = (R - M - 60) / 3;
    setD(COLORS.ink);
    doc.setLineWidth(0.8);
    doc.setFont("times", "normal");
    doc.setFontSize(8.5);
    setC(COLORS.ink);
    ["Prepared by (family member)", "Reviewed by (attorney)", "Date reviewed"].forEach((lab, i) => {
        const x = M + i * (colW + 30);
        doc.line(x, y, x + colW, y);
        doc.text(lab, x, y + 11);
    });
    y += 28;
    // Disclaimer
    doc.setFont("times", "normal");
    doc.setFontSize(8);
    setC(COLORS.gray);
    const dLines = doc.splitTextToSize(d.disclaimer, R - M);
    need(dLines.length * 10 + 14);
    setD(COLORS.rule);
    doc.setLineWidth(0.6);
    doc.line(M, y, R, y);
    y += 12;
    doc.text(dLines, M, y);
    // Page numbers
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFont("courier", "normal");
        doc.setFontSize(7);
        setC(COLORS.gray);
        doc.text(`CSPA self-prepared estimate · ${d.today} · page ${i} of ${pages}`, M, H - 30);
    }
}
/* ────────────────────────────────────────────────────────────
   PDF WRITER — dependency-free. Implements the same drawing API
   the layout engine (renderReportPDF) calls, then serializes raw
   PDF 1.4 with the standard Type1 fonts. No network, no library,
   nothing for a Content-Security-Policy to block.
   ──────────────────────────────────────────────────────────── */
const PDF_FONTS = {
    "helvetica:normal": { res: "F1", base: "Helvetica", factor: 0.55 },
    "helvetica:bold": { res: "F2", base: "Helvetica-Bold", factor: 0.58 },
    "times:normal": { res: "F3", base: "Times-Roman", factor: 0.52 },
    "times:bold": { res: "F4", base: "Times-Bold", factor: 0.54 },
    "courier:normal": { res: "F5", base: "Courier", factor: 0.6 },
    "courier:bold": { res: "F6", base: "Courier-Bold", factor: 0.6 },
};
// Unicode → WinAnsi for the characters the report actually uses.
const WINANSI = {
    0x2014: 0x97, 0x2013: 0x96, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x00B7: 0xB7, 0x00A7: 0xA7, 0x00B0: 0xB0, 0x2022: 0x95,
};
function PDFWriter() {
    this.pageH = 792;
    this.pageW = 612;
    this.pages = [[]];
    this.cur = 0;
    this.fontKey = "times:normal";
    this.size = 10;
    this.fill = "0.000 0.000 0.000";
    this.stroke = "0.000 0.000 0.000";
    this.lineW = 1;
}
PDFWriter.prototype._ops = function () { return this.pages[this.cur]; };
PDFWriter.prototype._col = function (r, g, b) {
    return `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`;
};
PDFWriter.prototype.setFont = function (fam, style) {
    const key = `${fam}:${style || "normal"}`;
    this.fontKey = PDF_FONTS[key] ? key : "times:normal";
};
PDFWriter.prototype.setFontSize = function (s) { this.size = s; };
PDFWriter.prototype.setTextColor = function (r, g, b) { this.fill = this._col(r, g, b); };
PDFWriter.prototype.setDrawColor = function (r, g, b) { this.stroke = this._col(r, g, b); };
PDFWriter.prototype.setLineWidth = function (w) { this.lineW = w; };
PDFWriter.prototype.addPage = function () { this.pages.push([]); this.cur = this.pages.length - 1; };
PDFWriter.prototype.setPage = function (i) { this.cur = Math.min(Math.max(i - 1, 0), this.pages.length - 1); };
PDFWriter.prototype.getNumberOfPages = function () { return this.pages.length; };
PDFWriter.prototype._encode = function (str) {
    let out = "";
    for (const ch of String(str)) {
        let code = ch.codePointAt(0);
        if (code > 0xff)
            code = WINANSI[code] || 0x3f; // '?'
        if (code === 0x28 || code === 0x29 || code === 0x5c)
            out += "\\" + String.fromCharCode(code);
        else if (code === 0x0a || code === 0x0d)
            out += " ";
        else
            out += String.fromCharCode(code);
    }
    return out;
};
PDFWriter.prototype.splitTextToSize = function (text, maxW) {
    const factor = (PDF_FONTS[this.fontKey] || PDF_FONTS["times:normal"]).factor;
    const capPts = Math.max(maxW, 20);
    const widthOf = (s) => s.length * factor * this.size;
    const lines = [];
    for (const rawLine of String(text).split(/\n/)) {
        const words = rawLine.split(/\s+/).filter(Boolean);
        let line = "";
        for (let w of words) {
            // hard-split any single word wider than the column
            while (widthOf(w) > capPts) {
                const fit = Math.max(1, Math.floor(capPts / (factor * this.size)) - 1);
                if (line) {
                    lines.push(line);
                    line = "";
                }
                lines.push(w.slice(0, fit) + "-");
                w = w.slice(fit);
            }
            const candidate = line ? line + " " + w : w;
            if (widthOf(candidate) > capPts && line) {
                lines.push(line);
                line = w;
            }
            else
                line = candidate;
        }
        lines.push(line);
    }
    return lines.length ? lines : [""];
};
PDFWriter.prototype.text = function (t, x, y) {
    const f = PDF_FONTS[this.fontKey];
    const lines = Array.isArray(t) ? t : [String(t)];
    let yy = y;
    for (const line of lines) {
        this._ops().push(`${this.fill} rg BT /${f.res} ${this.size.toFixed(2)} Tf 1 0 0 1 ${x.toFixed(2)} ${(this.pageH - yy).toFixed(2)} Tm (${this._encode(line)}) Tj ET`);
        yy += this.size * 1.18;
    }
};
PDFWriter.prototype.line = function (x1, y1, x2, y2) {
    this._ops().push(`${this.stroke} RG ${this.lineW.toFixed(2)} w ${x1.toFixed(2)} ${(this.pageH - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.pageH - y2).toFixed(2)} l S`);
};
PDFWriter.prototype.rect = function (x, y, w, h) {
    this._ops().push(`${this.stroke} RG ${this.lineW.toFixed(2)} w ${x.toFixed(2)} ${(this.pageH - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
};
PDFWriter.prototype.output = function () {
    const fontEntries = Object.values(PDF_FONTS);
    const nFonts = fontEntries.length;
    const nPages = this.pages.length;
    // ids: 1 catalog, 2 pages tree, 3..(2+nFonts) fonts, then page/content pairs
    const firstPageId = 3 + nFonts;
    const bodies = [];
    const kids = [];
    for (let i = 0; i < nPages; i++)
        kids.push(`${firstPageId + i * 2} 0 R`);
    bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    bodies[2] = `<< /Type /Pages /Kids [ ${kids.join(" ")} ] /Count ${nPages} >>`;
    fontEntries.forEach((f, i) => {
        bodies[3 + i] = `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`;
    });
    const fontDict = fontEntries.map((f, i) => `/${f.res} ${3 + i} 0 R`).join(" ");
    this.pages.forEach((ops, i) => {
        const pageId = firstPageId + i * 2;
        const contentId = pageId + 1;
        bodies[pageId] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] ` +
                `/Resources << /Font << ${fontDict} >> >> /Contents ${contentId} 0 R >>`;
        const stream = ops.join("\n");
        bodies[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let id = 1; id < bodies.length; id++) {
        offsets[id] = out.length;
        out += `${id} 0 obj\n${bodies[id]}\nendobj\n`;
    }
    const xrefPos = out.length;
    out += `xref\n0 ${bodies.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < bodies.length; id++) {
        out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${bodies.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++)
        bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
};
/* ────────────────────────────────────────────────────────────
   MAIN
   ──────────────────────────────────────────────────────────── */
const BLANK = {
    category: null, sub: "", track: "aos",
    dob: "", married: false,
    receiptDate: "", approvalDate: "", fadDate: "", dffDate: "", i485Date: "",
    soughtDate: "", soughtAction: "i485", freezeDate: "",
    retrogressed: false, extraordinary: false, crossChargeable: false,
    priorPetition: false, naturalized: false,
    country: "ALL", priorityDate: "", fadSource: "manual",
    lookupConfidence: null, lookupBulletinMonth: null,
};
function CSPACalculator() {
    const [f, setF] = useState(BLANK);
    const [lookup, setLookup] = useState({ status: "idle", data: null, message: "" });
    const [copied, setCopied] = useState(false);
    const [saveState, setSaveState] = useState("idle");
    const loadedRef = useRef(false);
    const set = (k) => (v) => setF((prev) => ({ ...prev, [k]: v }));
    const cat = f.category ? CATEGORIES[f.category] : null;
    const r = useMemo(() => evaluate(f), [f]);
    const catEntry = cat && cat.subs ? cat.subs.find((s) => s[0] === f.sub) : null;
    const rowLabel = catEntry ? catEntry[2] : f.sub || (cat ? cat.label : "");
    /* ── step gating: each step opens only when the last has what it needs ── */
    const isFormula = cat && cat.mode === "formula";
    const isFreeze = cat && cat.mode === "freeze";
    const isExcluded = cat && cat.mode === "excluded";
    const s1done = !!f.category;
    const s2open = isFormula;
    const s2done = isFormula && !!f.sub;
    const childOpen = (isFormula && s2done) || isFreeze;
    const childDone = childOpen && !!parseDate(f.dob);
    const petitionOpen = isFormula && childDone;
    const petitionDone = petitionOpen && !!parseDate(f.receiptDate) && !!parseDate(f.approvalDate);
    const freezeOpen = isFreeze && childDone;
    const freezeDone = freezeOpen && !!parseDate(f.freezeDate);
    const availOpen = isFormula && petitionDone;
    const availDone = availOpen && !!parseDate(f.fadDate);
    const soughtOpen = isFormula && availDone;
    const circOpen = (isFormula && petitionDone) || freezeDone;
    const resultOpen = (isFormula && petitionDone) || freezeDone || isExcluded;
    const inWindow = (() => {
        const d = parseDate(f.i485Date);
        return d != null && d >= POLICY_2023 && d < POLICY_SHIFT;
    })();
    /* ── persistence ── */
    useEffect(() => {
        (async () => {
            try {
                const res = await window.storage.get("cspa:case");
                if (res && res.value) {
                    setF((p) => ({ ...p, ...JSON.parse(res.value) }));
                    setSaveState("loaded");
                }
            }
            catch (e) { /* fresh start */ }
            finally {
                loadedRef.current = true;
            }
        })();
    }, []);
    useEffect(() => {
        if (!loadedRef.current)
            return;
        const t = setTimeout(async () => {
            try {
                await window.storage.set("cspa:case", JSON.stringify(f));
                setSaveState("saved");
            }
            catch (e) {
                setSaveState("off");
            }
        }, 600);
        return () => clearTimeout(t);
    }, [f]);
    async function clearCase() {
        setF(BLANK);
        setLookup({ status: "idle", data: null, message: "" });
        try {
            await window.storage.delete("cspa:case");
        }
        catch (e) { /* nothing saved */ }
        setSaveState("idle");
    }
    async function runLookup() {
        setLookup({ status: "loading", data: null, message: "" });
        try {
            const data = await lookupBulletin({
                rowLabel,
                countryLabel: COUNTRY_LABEL[f.country],
                priorityDate: f.priorityDate,
            });
            setLookup({ status: "done", data, message: "" });
            if (data.retrogressed_since === true)
                setF((p) => ({ ...p, retrogressed: true }));
        }
        catch (err) {
            setLookup({ status: "error", data: null, message: err && err.message ? err.message : "The lookup failed." });
        }
    }
    function applyLookup() {
        const d = lookup.data;
        if (!d || !d.first_current_month)
            return;
        const iso = monthToFirstDay(d.first_current_month);
        if (!iso)
            return;
        setF((p) => ({
            ...p, fadDate: iso, fadSource: "fetched",
            lookupConfidence: d.first_current_confidence || "low",
            lookupBulletinMonth: d.bulletin_month || null,
        }));
    }
    const extraordinaryCount = r && r.flags ? r.flags.filter((x) => x.tier === "extraordinary").length : 0;
    function reportHTML() {
        return buildReportHTML(f, r, { cat, catEntry, extraordinaryCount });
    }
    const [pdfState, setPdfState] = useState("idle"); // idle | failed
    function downloadPDF() {
        if (!r || !r.cspaAge)
            return;
        try {
            const doc = new PDFWriter();
            const data = buildReportData(f, r, { cat, catEntry, extraordinaryCount });
            renderReportPDF(doc, data);
            const bytes = doc.output();
            const blob = new Blob([bytes], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `cspa-estimate-${new Date().toISOString().slice(0, 10)}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            setPdfState("idle");
        }
        catch (e) {
            // If even a local blob download is blocked, hand over the HTML report,
            // which prints to PDF from any browser.
            setPdfState("failed");
            downloadReport();
        }
    }
    function downloadReport() {
        if (!r || !r.cspaAge)
            return;
        try {
            const blob = new Blob([reportHTML()], { type: "text/html;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `cspa-estimate-${new Date().toISOString().slice(0, 10)}.html`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        }
        catch (e) { /* download blocked; print path remains */ }
    }
    function printReport() {
        if (!r || !r.cspaAge)
            return;
        try {
            const iframe = document.createElement("iframe");
            iframe.style.position = "fixed";
            iframe.style.right = "0";
            iframe.style.bottom = "0";
            iframe.style.width = "0";
            iframe.style.height = "0";
            iframe.style.border = "0";
            document.body.appendChild(iframe);
            const doc = iframe.contentWindow.document;
            doc.open();
            doc.write(reportHTML());
            doc.close();
            iframe.onload = () => {
                try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                }
                catch (e) {
                    downloadReport();
                }
                setTimeout(() => iframe.remove(), 60000);
            };
            // Some browsers fire load synchronously after close():
            setTimeout(() => {
                try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                }
                catch (e) { /* handled by onload or fallback */ }
            }, 250);
        }
        catch (e) {
            downloadReport();
        }
    }
    function copySummary() {
        if (!r || !r.cspaAge)
            return;
        const lines = [
            "CSPA AGE — ESTIMATE",
            `Category: ${cat ? cat.label : ""}${catEntry ? ` (${f.sub})` : ""}`,
            `Statute: ${cat ? cat.statute : ""}`,
            `Date of birth: ${fmt(r.dob)}`,
            r.availabilityDate ? `Visa availability: ${fmt(r.availabilityDate)}` : `Age locked on: ${fmt(r.referenceDate)}`,
            r.pendingDays ? `Pending time subtracted: ${r.pendingDays} days` : null,
            f.fadSource === "fetched"
                ? `Availability source: Visa Bulletin lookup, ${f.lookupConfidence} confidence — UNVERIFIED`
                : r.mode === "formula" ? "Availability source: entered by hand" : null,
            `CSPA age: ${ageString(r.cspaAge)}`,
            `Result: ${r.qualifies ? "Protected as a child"
                : r.conditional ? `Protected IF a qualifying step is taken by ${fmt(r.soughtDeadline)}`
                    : "Not protected on these inputs"}`,
            "",
            `Items needing a human judgment: ${extraordinaryCount}`,
            ...r.flags.filter((x) => x.tier === "extraordinary").map((x) => `  ‡ ${x.title}`),
            "",
            "Estimate only. Not legal advice.",
        ].filter(Boolean);
        try {
            navigator.clipboard.writeText(lines.join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        }
        catch (e) { /* clipboard unavailable */ }
    }
    let stepNo = 1;
    return (React.createElement("div", { className: "cspa-root" },
        React.createElement("style", null, `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=JetBrains+Mono:wght@400;500;700&display=swap');

.cspa-root {
  --ground: #EAF2FA; --band: #DCE9F7; --panel: #F6FAFE;
  --ink: #0B1526; --ink-2: #3E5470; --ink-3: #7189A6; --rule: #A9C3DE;
  --royal: #2447C7; --royal-deep: #1B36A0;
  --clear: #0D7A72; --stop: #B3261E; --hold: #B07818;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Archivo', system-ui, -apple-system, sans-serif;
  --serif: 'Source Serif 4', Georgia, serif;
  background: var(--ground); color: var(--ink); font-family: var(--sans);
  min-height: 100vh; padding: 22px 16px 64px; -webkit-font-smoothing: antialiased;
}
.cspa-wrap { max-width: 720px; margin: 0 auto; }

.cspa-masthead { border-bottom: 2px solid var(--royal); padding-bottom: 12px; margin-bottom: 4px; }
.cspa-title { font-weight: 700; font-size: 27px; line-height: 1.05; letter-spacing: -0.025em; margin: 0 0 6px; }
.cspa-sub { font-family: var(--serif); font-size: 14.5px; line-height: 1.5; color: var(--ink-2); margin: 0; }
.cspa-stamp { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 7px; }
.cspa-eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3); }
.cspa-cite { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); margin-left: auto; }

.cspa-persist { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 10px; }
.cspa-persist-state { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.cspa-persist-clear { background: none; border: none; cursor: pointer; padding: 0; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); text-decoration: underline; text-underline-offset: 3px; }
.cspa-persist-clear:hover { color: var(--stop); }

/* ── steps ── */
.cspa-step { margin-top: 22px; border-left: 2px solid var(--rule); padding-left: 16px; animation: cspa-in .35s ease both; }
.cspa-step.is-done { border-left-color: var(--clear); }
@keyframes cspa-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .cspa-step { animation: none; } }
.cspa-step-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.cspa-step-n {
  font-family: var(--mono); font-size: 11px; font-weight: 700; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  border: 1.5px solid var(--royal); color: var(--royal); border-radius: 50%; transform: translateY(3px);
}
.cspa-step.is-done .cspa-step-n { background: var(--clear); border-color: var(--clear); color: #fff; }
.cspa-step-t { font-size: 15px; font-weight: 700; letter-spacing: -0.015em; margin: 0; }
.cspa-step-body { }

.cspa-cats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
@media (max-width: 520px) { .cspa-cats { grid-template-columns: 1fr; } }
.cspa-cat { text-align: left; background: var(--panel); border: 1px solid var(--rule); padding: 10px 11px; cursor: pointer; font-family: var(--sans); transition: background .13s, border-color .13s; }
.cspa-cat:hover { background: #fff; }
.cspa-cat[aria-pressed="true"] { background: var(--royal); border-color: var(--royal); }
.cspa-cat-l { display: block; font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; }
.cspa-cat-d { display: block; font-family: var(--mono); font-size: 10px; color: var(--ink-3); margin-top: 3px; }
.cspa-cat[aria-pressed="true"] .cspa-cat-l { color: #fff; }
.cspa-cat[aria-pressed="true"] .cspa-cat-d { color: #B9CBF2; }

.cspa-seg { display: flex; border: 1px solid var(--rule); background: var(--panel); margin-top: 12px; }
.cspa-seg button { flex: 1; padding: 9px 8px; background: none; border: none; cursor: pointer; font-family: var(--sans); font-size: 12.5px; font-weight: 500; color: var(--ink-2); }
.cspa-seg button + button { border-left: 1px solid var(--rule); }
.cspa-seg button[aria-pressed="true"] { background: var(--royal); color: #fff; font-weight: 600; }

.cspa-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
@media (max-width: 520px) { .cspa-grid { grid-template-columns: 1fr; } }
.cspa-field { display: flex; flex-direction: column; gap: 5px; }
.cspa-label { font-size: 11.5px; font-weight: 600; color: var(--ink); }
.cspa-hint { font-family: var(--serif); font-size: 12px; line-height: 1.4; color: var(--ink-3); }
.cspa-input, .cspa-select { font-family: var(--mono); font-size: 13.5px; padding: 8px 9px; border: 1px solid var(--rule); background: var(--panel); color: var(--ink); width: 100%; box-sizing: border-box; border-radius: 0; }
.cspa-select { font-family: var(--sans); font-size: 13px; }
.cspa-input:focus-visible, .cspa-select:focus-visible, .cspa-cat:focus-visible, .cspa-seg button:focus-visible,
.cspa-copy:focus-visible, .cspa-lookup-go:focus-visible, .cspa-lookup-apply:focus-visible, .cspa-persist-clear:focus-visible {
  outline: 2px solid var(--royal); outline-offset: 1px;
}
.cspa-check { display: flex; gap: 9px; align-items: flex-start; padding: 7px 0; cursor: pointer; }
.cspa-check input { margin-top: 2px; accent-color: var(--ink); flex-shrink: 0; }
.cspa-check span { font-family: var(--serif); font-size: 13.5px; line-height: 1.45; color: var(--ink-2); }

.cspa-lede { font-family: var(--serif); font-size: 13.5px; line-height: 1.5; color: var(--ink-2); margin: 0 0 13px; }

/* ── threshold rule ── */
.cspa-rule { margin: 4px 0; }
.cspa-rule-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 9px; }
.cspa-rule-legend { font-family: var(--mono); font-size: 9.5px; color: var(--ink-3); display: flex; align-items: center; gap: 5px; }
.cspa-sw { width: 9px; height: 9px; display: inline-block; }
.cspa-sw-in { background: #BFE3DE; margin-left: 4px; }
.cspa-sw-out { background: #F0CFCB; margin-left: 10px; }
.cspa-track { position: relative; height: 54px; border: 1px solid var(--rule); overflow: hidden; }
.cspa-zone-in { position: absolute; inset: 0 auto 0 0; background: #BFE3DE; }
.cspa-zone-out { position: absolute; top: 0; bottom: 0; background: #F0CFCB; }
.cspa-line { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ink); }
.cspa-line-tag { position: absolute; top: 4px; left: 5px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.06em; white-space: nowrap; }
.cspa-pull { position: absolute; top: 26px; height: 2px; background: var(--ink-2); opacity: .5; }
.cspa-marker { position: absolute; top: 18px; transform: translateX(-50%); transition: left .5s cubic-bezier(.2,.7,.2,1); }
.cspa-marker-dot { display: block; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--ink); background: #fff; }
.cspa-marker-ghost .cspa-marker-dot { border-style: dotted; opacity: .55; width: 10px; height: 10px; margin: 2px; }
.cspa-marker-live.is-in .cspa-marker-dot { background: var(--clear); }
.cspa-marker-live.is-out .cspa-marker-dot { background: var(--stop); }
.cspa-rule-foot { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 8px; font-family: var(--mono); font-size: 10.5px; color: var(--ink-2); }
.cspa-rule-foot b { color: var(--ink); font-weight: 700; }
.cspa-pull-label { color: var(--ink-3); }
@media (prefers-reduced-motion: reduce) { .cspa-marker { transition: none; } }

/* ── verdict ── */
.cspa-verdict { border: 2px solid var(--ink); background: var(--panel); padding: 16px 15px; margin-top: 18px; }
.cspa-verdict-age { font-family: var(--mono); font-size: 34px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; margin: 2px 0 8px; }
.cspa-verdict-call { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.cspa-verdict.is-in { border-color: var(--clear); }
.cspa-verdict.is-in .cspa-verdict-call { color: var(--clear); }
.cspa-verdict.is-cond { border-color: var(--hold); background: #FCF4E4; }
.cspa-verdict.is-cond .cspa-verdict-call { color: var(--hold); }
.cspa-verdict.is-out { border-color: var(--stop); }
.cspa-verdict.is-out .cspa-verdict-call { color: var(--stop); }
.cspa-verdict-note { font-family: var(--serif); font-size: 13px; line-height: 1.5; color: var(--ink-2); margin: 7px 0 0; }

/* ── ledger ── */
.cspa-ledger { margin-top: 16px; border: 1px solid var(--rule); }
.cspa-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 11px; align-items: baseline; }
.cspa-row:nth-child(odd) { background: var(--band); }
.cspa-row:nth-child(even) { background: var(--panel); }
.cspa-row-k { font-size: 11.5px; color: var(--ink-2); }
.cspa-row-v { font-size: 12.5px; text-align: right; }
.cspa-row-v.mono { font-family: var(--mono); }
.cspa-row-v.strong { font-weight: 700; }

/* ── flags ── */
.cspa-flags { margin-top: 22px; display: flex; flex-direction: column; gap: 10px; }
.cspa-flag { padding: 12px 13px; background: var(--panel); border: 1px solid var(--rule); }
.cspa-flag-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.cspa-flag-mark { font-family: var(--mono); font-size: 12px; line-height: 1; }
.cspa-flag-word { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.15em; text-transform: uppercase; }
.cspa-flag-title { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 4px; }
.cspa-flag-body { font-family: var(--serif); font-size: 13.5px; line-height: 1.52; color: var(--ink-2); margin: 0; }
.cspa-flag-bar { border-left: 5px solid var(--stop); background: #FBEFED; }
.cspa-flag-bar .cspa-flag-mark, .cspa-flag-bar .cspa-flag-word { color: var(--stop); }
.cspa-flag-extraordinary { border: 1px solid var(--hold); border-top: 3px double var(--hold); border-bottom: 3px double var(--hold); background: #FCF4E4; }
.cspa-flag-extraordinary .cspa-flag-mark { color: var(--hold); font-size: 14px; }
.cspa-flag-extraordinary .cspa-flag-word { color: var(--hold); font-weight: 700; }
.cspa-flag-extraordinary .cspa-flag-body { font-style: italic; }
.cspa-flag-note { border-left: 5px solid var(--rule); }
.cspa-flag-note .cspa-flag-mark, .cspa-flag-note .cspa-flag-word { color: var(--ink-3); }

.cspa-tally { display: flex; align-items: baseline; gap: 8px; padding: 9px 11px; background: var(--ink); color: #fff; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 16px; }
.cspa-tally b { color: #F0C36A; font-size: 12px; }

.cspa-empty { border: 1px dashed var(--rule); background: var(--panel); padding: 18px 16px; text-align: center; font-family: var(--serif); font-size: 13.5px; color: var(--ink-3); line-height: 1.5; }

.cspa-copy { margin-top: 14px; width: 100%; padding: 10px; background: none; cursor: pointer; border: 1px solid var(--royal); color: var(--royal); font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.13em; text-transform: uppercase; }
.cspa-copy:hover { background: var(--royal); color: #fff; }

.cspa-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
@media (max-width: 520px) { .cspa-actions { flex-direction: column; } }
.cspa-act { flex: 1; min-width: 130px; padding: 11px 8px; cursor: pointer; background: none; border: 1px solid var(--royal); color: var(--royal); font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; }
.cspa-act:hover:not(:disabled) { background: var(--royal); color: #fff; }
.cspa-act:disabled { opacity: .55; cursor: wait; }
.cspa-act:focus-visible { outline: 2px solid var(--royal); outline-offset: 1px; }
.cspa-act-primary { background: var(--royal); color: #fff; }
.cspa-act-primary:hover:not(:disabled) { background: var(--royal-deep); }
.cspa-actions-hint { font-family: var(--serif); font-size: 12.5px; line-height: 1.5; color: var(--ink-3); margin: 9px 0 0; }

/* ── projection ── */
.cspa-proj { border: 2px solid var(--ink); background: var(--panel); padding: 15px 14px; }
.cspa-proj-clear { border-color: var(--clear); }
.cspa-proj-watch { border-color: var(--hold); }
.cspa-proj-urgent { border-color: var(--hold); background: #FCF4E4; }
.cspa-proj-out { border-color: var(--stop); background: #FBEFED; }
.cspa-proj-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.cspa-proj-word { font-size: 12.5px; font-weight: 700; }
.cspa-proj-clear .cspa-proj-word { color: var(--clear); }
.cspa-proj-watch .cspa-proj-word, .cspa-proj-urgent .cspa-proj-word { color: var(--hold); }
.cspa-proj-out .cspa-proj-word { color: var(--stop); }
.cspa-proj-main { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 520px) { .cspa-proj-main { grid-template-columns: 1fr; } }
.cspa-proj-cell { display: flex; flex-direction: column; gap: 4px; }
.cspa-proj-k { font-size: 11px; color: var(--ink-2); }
.cspa-proj-v { font-family: var(--mono); font-size: 21px; font-weight: 700; letter-spacing: -0.02em; }
.cspa-proj-sub { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 10.5px; color: var(--ink-2); }
.cspa-proj-sub b { color: var(--ink); font-weight: 700; }
.cspa-proj-note { font-family: var(--serif); font-size: 13px; line-height: 1.55; color: var(--ink-2); margin: 11px 0 0; }

.cspa-clock { display: flex; flex-direction: column; gap: 3px; margin-top: 16px; padding: 10px 12px; border: 1px solid var(--hold); border-left-width: 5px; background: #FCF4E4; }
.cspa-clock-k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--hold); }
.cspa-clock-v { font-size: 13px; font-weight: 600; }

/* ── lookup ── */
.cspa-lookup { border: 1px solid var(--royal); background: var(--panel); padding: 14px 13px; }
.cspa-rowtarget { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; margin-bottom: 13px; background: var(--band); border-left: 4px solid var(--royal); }
.cspa-rowtarget-v { font-family: var(--mono); font-size: 11.5px; font-weight: 700; line-height: 1.35; }
.cspa-rowtarget-c { font-weight: 400; color: var(--ink-2); }
.cspa-lookup-go { margin-top: 13px; width: 100%; padding: 11px; cursor: pointer; background: var(--royal); color: #fff; border: 1px solid var(--royal); font-family: var(--mono); font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase; }
.cspa-lookup-go:hover:not(:disabled) { background: var(--royal-deep); }
.cspa-lookup-go:disabled { opacity: .4; cursor: not-allowed; }
.cspa-lookup-wait { display: flex; gap: 9px; align-items: flex-start; margin-top: 12px; font-family: var(--serif); font-size: 13px; line-height: 1.5; color: var(--ink-2); }
.cspa-pulse { width: 9px; height: 9px; background: var(--hold); flex-shrink: 0; margin-top: 4px; animation: cspa-blink 1.1s steps(2, start) infinite; }
@keyframes cspa-blink { 50% { opacity: .15; } }
@media (prefers-reduced-motion: reduce) { .cspa-pulse { animation: none; } }
.cspa-lookup-err { margin-top: 12px; padding: 10px 11px; background: #FBEFED; border-left: 5px solid var(--stop); font-family: var(--serif); font-size: 13px; line-height: 1.5; color: var(--ink-2); }
.cspa-lookup-out { margin-top: 14px; border-top: 1px solid var(--rule); padding-top: 12px; }
.cspa-lookup-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.cspa-lookup-month { font-family: var(--mono); font-size: 11px; font-weight: 700; }
.cspa-lookup-note { font-family: var(--serif); font-size: 12.5px; font-style: italic; line-height: 1.5; color: var(--ink-3); margin: 9px 0 0; }
.cspa-lookup-apply { margin-top: 12px; width: 100%; padding: 10px; cursor: pointer; background: none; border: 1px solid var(--clear); color: var(--clear); font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; }
.cspa-lookup-apply:hover { background: var(--clear); color: #fff; }
.cspa-lookup-src { display: inline-block; margin-top: 11px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; color: var(--ink-2); text-underline-offset: 3px; }
.cspa-tag { font-family: var(--mono); font-size: 8.5px; font-style: normal; letter-spacing: 0.12em; text-transform: uppercase; background: var(--hold); color: #fff; padding: 2px 5px; margin-left: 6px; }

.cspa-foot { margin-top: 30px; border-top: 1px solid var(--rule); padding-top: 12px; font-family: var(--serif); font-size: 12.5px; line-height: 1.55; color: var(--ink-3); }
      `),
        React.createElement("div", { className: "cspa-wrap" },
            React.createElement("header", { className: "cspa-masthead" },
                React.createElement("div", { className: "cspa-stamp" }, "Child Status Protection Act \u00B7 8 U.S.C. \u00A7 1151(f), 1153(h)"),
                React.createElement("h1", { className: "cspa-title" }, "Will my child age out?"),
                React.createElement("p", { className: "cspa-sub" },
                    "A step-by-step CSPA age estimator. It only asks for what your case actually needs, shows its arithmetic, and marks anything that needs a human judgment with ",
                    React.createElement("b", null, "\u2021"),
                    "."),
                React.createElement("div", { className: "cspa-persist" },
                    React.createElement("span", { className: "cspa-persist-state" },
                        saveState === "saved" && "Case saved on this device",
                        saveState === "loaded" && "Welcome back — your last case is restored",
                        saveState === "off" && "Saving unavailable — this case lives only on this screen",
                        saveState === "idle" && "Entries save automatically as you go"),
                    React.createElement("button", { className: "cspa-persist-clear", onClick: clearCase }, "Start over"))),
            React.createElement(Step, { n: stepNo++, title: "What kind of case is this?", done: s1done, open: true, aside: cat ? cat.statute : undefined },
                React.createElement("div", { className: "cspa-cats" }, Object.entries(CATEGORIES).map(([key, c]) => (React.createElement("button", { key: key, className: "cspa-cat", "aria-pressed": f.category === key, onClick: () => setF((p) => ({ ...p, category: key, sub: "" })) },
                    React.createElement("span", { className: "cspa-cat-l" }, c.label),
                    React.createElement("span", { className: "cspa-cat-d" }, c.detail))))),
                isFreeze && (React.createElement("p", { className: "cspa-lede", style: { marginTop: 12, marginBottom: 0 } }, "Good news for this category: the age simply locks on one date. Only two questions to go."))),
            isExcluded && (React.createElement("div", { className: "cspa-flags" }, r.flags.map((x, i) => React.createElement(Flag, { key: i, f: x })))),
            React.createElement(Step, { n: stepNo++, title: "Which line, and where is it processed?", done: s2done, open: s2open },
                React.createElement(Field, { label: "Preference line", hint: "This decides which Visa Bulletin row governs the case." },
                    React.createElement("select", { className: "cspa-select", value: f.sub, onChange: (e) => set("sub")(e.target.value) },
                        React.createElement("option", { value: "", disabled: true }, "Choose the line\u2026"),
                        cat && cat.subs && cat.subs.map(([v, l]) => React.createElement("option", { key: v, value: v }, l)))),
                s2done && (React.createElement("div", { className: "cspa-seg" },
                    React.createElement("button", { "aria-pressed": f.track === "aos", onClick: () => set("track")("aos") }, "Applying inside the U.S. (I-485)"),
                    React.createElement("button", { "aria-pressed": f.track === "cp", onClick: () => set("track")("cp") }, "Applying from abroad (consulate)")))),
            React.createElement(Step, { n: stepNo++, title: "About the child", done: childDone, open: childOpen },
                React.createElement("div", { className: "cspa-grid" },
                    React.createElement(Field, { label: "Date of birth" },
                        React.createElement(DateInput, { value: f.dob, onChange: set("dob") })),
                    isFreeze && cat && (React.createElement(Field, { label: cat.freezeLabel, hint: cat.freezeHint },
                        React.createElement(DateInput, { value: f.freezeDate, onChange: set("freezeDate") })))),
                React.createElement(Check, { checked: f.married, onChange: set("married") }, "The child is married, or expects to marry before the green card is granted.")),
            React.createElement(Step, { n: stepNo++, title: "The petition", done: petitionDone, open: petitionOpen, aside: "from the Form I-797" },
                React.createElement("p", { className: "cspa-lede" }, "Every day the petition sat with USCIS is a day subtracted from the child's age. Both dates are printed on the I-797 notices."),
                React.createElement("div", { className: "cspa-grid" },
                    React.createElement(Field, { label: "Receipt date", hint: "When USCIS received the petition." },
                        React.createElement(DateInput, { value: f.receiptDate, onChange: set("receiptDate") })),
                    React.createElement(Field, { label: "Approval date", hint: "When USCIS approved it." },
                        React.createElement(DateInput, { value: f.approvalDate, onChange: set("approvalDate") })),
                    f.track === "aos" && (React.createElement(Field, { label: "Date the I-485 was filed, if it has been", hint: "Leave blank if not filed yet. This decides which policy governs." },
                        React.createElement(DateInput, { value: f.i485Date, onChange: set("i485Date") }))),
                    f.track === "aos" && inWindow && (React.createElement(Field, { label: "Current under Dates for Filing", hint: "Your I-485 was pending before 15 Aug 2025, so the older, more generous rule may apply. Usually the better date." },
                        React.createElement(DateInput, { value: f.dffDate, onChange: set("dffDate") })))),
                petitionDone && (React.createElement("p", { className: "cspa-lede", style: { marginTop: 12, marginBottom: 0 } },
                    "Pending-time credit so far:",
                    " ",
                    React.createElement("b", { style: { fontFamily: "var(--mono)" } },
                        diffDays(parseDate(f.approvalDate), parseDate(f.receiptDate)).toLocaleString(),
                        " days")))),
            React.createElement(Step, { n: stepNo++, title: "When did a visa become available?", done: availDone, open: availOpen, aside: "travel.state.gov" },
                React.createElement("p", { className: "cspa-lede" },
                    "CSPA needs the month the priority date ",
                    React.createElement("i", null, "first"),
                    " became current \u2014 not today's cut-off."),
                React.createElement("div", { className: "cspa-lookup" },
                    React.createElement("div", { className: "cspa-rowtarget" },
                        React.createElement("span", { className: "cspa-eyebrow" }, "Your bulletin row"),
                        React.createElement("span", { className: "cspa-rowtarget-v" }, rowLabel)),
                    React.createElement("p", { className: "cspa-lede", style: { marginBottom: 8 } },
                        "Open the official Visa Bulletin, find the ",
                        React.createElement("b", null, "Final Action Dates"),
                        " chart, and look at the cell where your row above meets your country-of-birth column. You need the ",
                        React.createElement("i", null, "earliest month"),
                        " in which that cell reached or passed your priority date (printed on the Form I-797). Then enter the first day of that month below."),
                    React.createElement("a", { className: "cspa-lookup-src", href: "https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html", target: "_blank", rel: "noreferrer" }, "Open the Visa Bulletin at travel.state.gov \u2197")),
                React.createElement("div", { className: "cspa-grid", style: { marginTop: 14 } },
                    React.createElement(Field, { label: f.fadSource === "fetched"
                            ? React.createElement(React.Fragment, null,
                                "Availability date ",
                                React.createElement("em", { className: "cspa-tag" }, "from lookup"))
                            : "Availability date", hint: "First day of the bulletin month in which the priority date became current." },
                        React.createElement(DateInput, { value: f.fadDate, onChange: (v) => setF((p) => ({ ...p, fadDate: v, fadSource: "manual", lookupConfidence: null })) }))),
                !availDone && (React.createElement("div", { style: { marginTop: 14 } },
                    React.createElement(Projection, { dob: f.dob, receiptDate: f.receiptDate, approvalDate: f.approvalDate })))),
            React.createElement(Step, { n: stepNo++, title: "The one-year step", done: !!parseDate(f.soughtDate), open: soughtOpen },
                React.createElement("p", { className: "cspa-lede" }, "To lock in the protection, the child must \u201Cseek to acquire\u201D a green card within one year of the availability date. Leave the date blank if nothing has been done yet \u2014 the result will show the deadline."),
                React.createElement("div", { className: "cspa-grid" },
                    React.createElement(Field, { label: "What was done" },
                        React.createElement("select", { className: "cspa-select", value: f.soughtAction, onChange: (e) => set("soughtAction")(e.target.value) }, (f.track === "aos" ? SOUGHT_ACTIONS_AOS : SOUGHT_ACTIONS_CP).map(([v, l]) => (React.createElement("option", { key: v, value: v }, l))))),
                    React.createElement(Field, { label: "On what date" },
                        React.createElement(DateInput, { value: f.soughtDate, onChange: set("soughtDate") })))),
            React.createElement(Step, { n: stepNo++, title: "Does any of this apply?", done: false, open: circOpen, aside: "each one changes the answer" },
                isFormula && (React.createElement(React.Fragment, null,
                    React.createElement(Check, { checked: f.retrogressed, onChange: set("retrogressed") }, "The priority date became current and then moved backward again."),
                    React.createElement(Check, { checked: f.extraordinary, onChange: set("extraordinary") }, "Illness, a death in the family, bad legal advice, or a policy change affected the timing."),
                    React.createElement(Check, { checked: f.crossChargeable, onChange: set("crossChargeable") }, "A spouse in the family was born in a different country than the principal applicant."),
                    React.createElement(Check, { checked: f.priorPetition, onChange: set("priorPetition") }, "An earlier petition exists that might give a better priority date."))),
                !isFormula && (React.createElement("p", { className: "cspa-lede", style: { marginBottom: 0 } }, "Nothing else needed for this category \u2014 the result is below."))),
            resultOpen && !isExcluded && (React.createElement(Step, { n: stepNo++, title: "The result", done: !!(r && r.cspaAge), open: true, aside: r && r.chartName ? r.chartName : undefined }, !r || r.incomplete ? (React.createElement("div", { className: "cspa-empty" }, r && r.missing ? `Add ${r.missing} to see the result.` : "Complete the steps above to see the result.")) : r.error ? (React.createElement("div", { className: "cspa-flags", style: { marginTop: 0 } },
                React.createElement(Flag, { f: { tier: "bar", title: "Check the dates", body: r.error } }))) : (React.createElement(React.Fragment, null,
                React.createElement(ThresholdRule, { r: r }),
                React.createElement("div", { className: `cspa-verdict ${r.qualifies ? "is-in" : r.conditional ? "is-cond" : "is-out"}` },
                    React.createElement("div", { className: "cspa-eyebrow" }, "CSPA age"),
                    React.createElement("div", { className: "cspa-verdict-age" }, ageString(r.cspaAge)),
                    React.createElement("div", { className: "cspa-verdict-call" }, r.qualifies
                        ? "Protected as a child on these inputs"
                        : r.conditional
                            ? `Protected if a qualifying step is taken by ${fmt(r.soughtDeadline)}`
                            : r.under21
                                ? "Under 21, but a condition below defeats the benefit"
                                : "Aged out on these inputs"),
                    React.createElement("p", { className: "cspa-verdict-note" }, r.under21
                        ? `Computed as of ${fmt(r.referenceDate)}, which is ${Math.abs(diffDays(r.birthday21, r.referenceDate)).toLocaleString()} days before the 21st birthday on ${fmt(r.birthday21)}.`
                        : `Computed as of ${fmt(r.referenceDate)}, which is ${Math.abs(diffDays(r.referenceDate, r.birthday21)).toLocaleString()} days after the 21st birthday on ${fmt(r.birthday21)}.`)),
                React.createElement("div", { className: "cspa-ledger" },
                    React.createElement(Row, { k: "Date of birth", v: fmt(r.dob) }),
                    React.createElement(Row, { k: "Turns 21", v: fmt(r.birthday21) }),
                    r.mode === "formula" && (React.createElement(React.Fragment, null,
                        React.createElement(Row, { k: `Current under ${r.chartName}`, v: fmt(r.chartDate) }),
                        React.createElement(Row, { k: "Visa available", v: fmt(r.availabilityDate) }),
                        React.createElement(Row, { k: "Actual age then", v: ageString(r.realAgeAtRef) }),
                        React.createElement(Row, { k: "Petition pending", v: `− ${r.pendingDays.toLocaleString()} days` }),
                        React.createElement(Row, { k: "Governing policy", v: r.regime, mono: false }),
                        React.createElement(Row, { k: "One-year deadline", v: fmt(r.soughtDeadline) }),
                        React.createElement(Row, { k: "Step taken in time", v: r.sought == null
                                ? (r.soughtPending ? "not yet — clock open" : "not entered — deadline passed")
                                : r.soughtOk ? "yes" : "no" }))),
                    r.mode === "freeze" && (React.createElement(React.Fragment, null,
                        React.createElement(Row, { k: "Age locked on", v: fmt(r.referenceDate) }),
                        React.createElement(Row, { k: "Pending time", v: "not applicable" }))),
                    React.createElement(Row, { k: "CSPA age", v: ageString(r.cspaAge), strong: true })),
                r.mode === "formula" && r.sought == null && r.soughtDeadline > todayUTC() && (React.createElement("div", { className: "cspa-clock" },
                    React.createElement("span", { className: "cspa-clock-k" }, "One-year clock running"),
                    React.createElement("span", { className: "cspa-clock-v" },
                        diffDays(r.soughtDeadline, todayUTC()).toLocaleString(),
                        " days left to take a qualifying step \u2014 by ",
                        fmt(r.soughtDeadline)))),
                extraordinaryCount > 0 && (React.createElement("div", { className: "cspa-tally" },
                    React.createElement("span", null, "\u2021"),
                    React.createElement("span", null,
                        React.createElement("b", null, extraordinaryCount),
                        " item",
                        extraordinaryCount === 1 ? "" : "s",
                        " below need a human judgment \u2014 bring them to a lawyer"))),
                React.createElement("div", { className: "cspa-flags" }, ["bar", "extraordinary", "note"].flatMap((tier) => r.flags.filter((x) => x.tier === tier).map((x, i) => React.createElement(Flag, { key: `${tier}${i}`, f: x })))),
                React.createElement("div", { className: "cspa-actions" },
                    React.createElement("button", { className: "cspa-act cspa-act-primary", onClick: downloadPDF }, "Download PDF"),
                    React.createElement("button", { className: "cspa-act", onClick: printReport }, "Print"),
                    React.createElement("button", { className: "cspa-act", onClick: downloadReport }, "Download HTML"),
                    React.createElement("button", { className: "cspa-act", onClick: copySummary }, copied ? "Copied" : "Copy summary")),
                React.createElement("p", { className: "cspa-actions-hint" },
                    "Every format carries the same one-page report: all parameters as entered, the full calculation, the \u2021 questions for your attorney, note lines, and a signature block.",
                    pdfState === "failed" &&
                        " The PDF couldn't be saved in this environment, so the HTML report was downloaded instead — open it and use your browser's Print → Save as PDF."))))),
            React.createElement("footer", { className: "cspa-foot" },
                "An estimate, not legal advice. Reflects the Final Action Dates rule USCIS adopted on 15\u00A0August\u00A02025 and the grandfathering of adjustment applications pending before that date. The lookup reads the published Visa Bulletin live; its archive step is a search result, not a certified record, so fetched dates arrive labelled \u2014 confirm them against the bulletin. Diversity Visa cases are deliberately excluded: their fiscal-year deadline makes any age number misleading without a processing-time judgment. Every item marked ",
                React.createElement("b", null, "\u2021"),
                " turns on discretion or on facts outside the arithmetic, and belongs in front of an immigration attorney \u2014 the copy button prepares that conversation."))));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(CSPACalculator));
