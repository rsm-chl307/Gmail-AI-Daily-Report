// Daily Gmail Report (Gemini) - PUBLIC-SAFE VERSION
// Script Properties:
//   GEMINI_API_KEY
//   GEMINI_MODEL (e.g. models/gemini-2.5-flash)
// Optional:
//   REPORT_RECIPIENT
//
// Public-safe changes:
// 1) Uses Gmail snippet ONLY (no getPlainBody)
// 2) Shorter snippet length (default 400 chars)
// 3) Prompt includes strict redaction rules (OTP/verification codes/personal data)
// 4) Avoids logging or emitting raw model output / raw snippets anywhere
//
// CHANGELOG (post-public-v1; bugfix + stability):
// A) Prevent alert-email feedback loop:
//    - Exclude self-sent "Interview Invite Detected:" alert emails from the daily Gmail query.
//    - This prevents Gemini from re-classifying yesterday's alert email as a new interview invite.
// B) Add dedupe for interview alerts:
//    - Store alerted threadIds in Script Properties (ALERTED_THREAD_<threadId>).
//    - Avoid repeatedly sending alerts for the same Gmail thread across multiple days.
//    - Includes optional cleanup to keep properties from growing forever.
// C) Add retry for transient Gemini API errors (503/UNAVAILABLE):
//    - Exponential backoff (1s, 2s, 4s) up to MAX_RETRIES.

const DRY_RUN = false;
const TZ = "America/Los_Angeles";
const MAX_THREADS = 150;
const BATCH_SIZE = 30;
const MAX_OUT_TOKENS = 6000;
const LOW_CONF = 0.7;
const SNIPPET_MAX_CHARS = 400;

// CHANGE: Retry settings for transient Gemini errors
const MAX_RETRIES = 3;

// CHANGE: Dedupe/cleanup settings
const ALERT_DEDUPE_DAYS = 30; // keep "already alerted" records for 30 days

function sendDailyGmailReport_Gemini() {
  const apiKey = getProp_("GEMINI_API_KEY");
  const modelRaw = getProp_("GEMINI_MODEL");
  const model = modelRaw.startsWith("models/") ? modelRaw : ("models/" + modelRaw);
  const to = PropertiesService.getScriptProperties().getProperty("REPORT_RECIPIENT") || Session.getActiveUser().getEmail();

  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(0, 0, 0, 0);

  const startStr = Utilities.formatDate(start, TZ, "yyyy/MM/dd");
  const endStr = Utilities.formatDate(end, TZ, "yyyy/MM/dd");

  // CHANGE: Prevent feedback loop by excluding self-sent alert emails
  // -from:me avoids most self-generated emails re-entering the pipeline
  // -subject:"Interview Invite Detected:" is an extra safeguard in case of aliases/forwarding
  const myEmail = Session.getActiveUser().getEmail();
  const query =
    `in:inbox category:primary after:${startStr} before:${endStr} ` +
    `-from:${myEmail} -subject:"Interview Invite Detected:"`;

  const threads = GmailApp.search(query, 0, MAX_THREADS);

  if (!threads || threads.length === 0) {
    if (!DRY_RUN) {
      MailApp.sendEmail(
        to,
        `Daily Gmail Report (${startStr}) - 0 emails`,
        `No matching emails received on ${startStr}.`
      );
    }
    return;
  }

  // CHANGE: Optional cleanup to prevent Script Properties growth
  cleanupOldAlertRecords_(ALERT_DEDUPE_DAYS);

  // Build items + mapping (PUBLIC-SAFE: snippet ONLY, no plain body)
  const items = [];
  const map = {};
  for (let i = 0; i < threads.length; i++) {
    const th = threads[i];
    const msg = th.getMessages().slice(-1)[0];
    const id = "e" + (i + 1);

    const safeSnippet = (msg.getSnippet() || "")
      .replace(/\s+/g, " ")
      .slice(0, SNIPPET_MAX_CHARS);

    items.push({
      id,
      time: Utilities.formatDate(msg.getDate(), TZ, "yyyy-MM-dd HH:mm"),
      from: msg.getFrom(),
      subject: msg.getSubject() || "(no subject)",
      snippet: safeSnippet
    });

    map[id] = th.getId();
  }

  // Classify in batches (reduce truncation risk)
  const parsed = [];
  const batches = chunk_(items, BATCH_SIZE);

  for (let b = 0; b < batches.length; b++) {
    const payload = batches[b].map(it =>
      `ID: ${it.id}\nTime: ${it.time}\nFrom: ${it.from}\nSubject: ${it.subject}\nSnippet: ${it.snippet}`
    ).join("\n\n---\n\n");

    const prompt = buildPrompt_(payload);

    // CHANGE: Retry wrapper for transient errors
    const raw = callGeminiWithRetry_(apiKey, model, prompt, MAX_OUT_TOKENS, MAX_RETRIES);

    const arr = safeJsonParse_(raw);
    if (Array.isArray(arr)) parsed.push(...arr);
  }

  // Labels
  const L_INV = getOrCreateLabel_("Interview-Invite-AI");
  const L_AUTO = getOrCreateLabel_("Auto-Reply-AI");
  const L_REVIEW = getOrCreateLabel_("Needs-Review-AI");

  // Process + report
  const counts = { interview: 0, auto_reply: 0, other: 0, needs_review: 0 };
  const invites = [];
  const reviews = [];

  parsed.forEach(x => {
    const id = x && x.id;
    const threadId = id ? map[id] : null;
    const thread = threadId ? GmailApp.getThreadById(threadId) : null;

    const conf = Number(x && x.confidence);
    const confidence = isFinite(conf) ? conf : 0;
    const category = (x && x.category) ? String(x.category) : "other";

    if (confidence < LOW_CONF) {
      counts.needs_review++;
      if (thread) thread.addLabel(L_REVIEW);
      reviews.push(minRow_(x, confidence, category));
      return;
    }

    if (category === "interview_invite") {
      counts.interview++;
      if (thread) thread.addLabel(L_INV);

      const row = inviteRow_(x, confidence);
      invites.push(row);

      // CHANGE: Dedupe - alert only once per Gmail thread
      // Prevents repeated alerts for the same interview thread across multiple days.
      const alreadyAlerted = threadId ? isThreadAlerted_(threadId) : false;

      if (!alreadyAlerted && threadId) {
        markThreadAlerted_(threadId);

        // Immediate alert (public-safe: does not include original email snippet, only model's short justification)
        if (!DRY_RUN) {
          const subj = `Interview Invite Detected: ${row.company} – ${row.position}`;
          const body =
`An interview invitation was detected.

Company: ${row.company}
Position: ${row.position}
Contact: ${row.contact}
Proposed times: ${row.proposed_times.length ? row.proposed_times.join(", ") : "N/A"}
Urgency: ${row.urgency}
Confidence: ${row.confidence}

Reason (redacted-safe):
${row.snippet}
`;
          MailApp.sendEmail(to, subj, body);
        }
      }

      return;
    }

    if (category === "auto_reply") {
      counts.auto_reply++;
      if (thread) thread.addLabel(L_AUTO);
      return;
    }

    counts.other++;
  });

  const report = buildReport_(threads.length, counts, invites, reviews);
  if (!DRY_RUN) {
    MailApp.sendEmail(to, `Daily Gmail Report (${startStr}) - ${threads.length} emails`, report);
  }
}


// ---------- Helpers ----------

function buildPrompt_(emailsPayload) {
  return `
You are an assistant that classifies emails for a job seeker.

PRIVACY / REDACTION RULES (strict):
- Do NOT output any one-time passwords (OTP), verification codes, passcodes, reset codes, or security tokens.
- If an email snippet contains a code or sensitive personal data, you must REDACT it in your output (replace with "[REDACTED]").
- Do NOT include phone numbers, street addresses, or any personal identifiers beyond what is necessary to classify.
- Keep "snippet" as a short justification; do not copy long text from the email.

For each email item, output one JSON object with:
- id
- category: "auto_reply" | "interview_invite" | "other"
- company (nullable)
- position (nullable)
- contact (nullable)
- proposed_times (array or null)
- urgency: "high" | "normal"
- confidence: number 0-1
- snippet: short justification (privacy-safe)

IMPORTANT: Return ONLY a valid JSON array. No extra text.

Emails:
---
${emailsPayload}
---
`.trim();
}

function callGemini_(apiKey, model, prompt, maxOut) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: maxOut || 6000 }
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`Gemini API error ${code}: ${text || "(empty)"}`);

  const obj = JSON.parse(text);
  const parts = obj?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text).filter(Boolean).join("").trim();
}

// CHANGE: Retry wrapper for transient failures (503 / UNAVAILABLE)
function callGeminiWithRetry_(apiKey, model, prompt, maxOut, maxRetries) {
  maxRetries = maxRetries || 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return callGemini_(apiKey, model, prompt, maxOut);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);

      // Retry only for transient errors
      if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
        Utilities.sleep(Math.pow(2, attempt - 1) * 1000); // 1s, 2s, 4s
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function safeJsonParse_(text) {
  try {
    return JSON.parse(text);
  } catch (e1) {
    const s = String(text || "").trim();
    const a = s.indexOf("[");
    if (a === -1) throw e1;

    const b = s.lastIndexOf("]");
    if (b > a) return JSON.parse(s.slice(a, b + 1));

    const lastObj = s.lastIndexOf("}");
    if (lastObj > a) return JSON.parse(s.slice(a, lastObj + 1) + "\n]");
    throw e1;
  }
}

function buildReport_(total, counts, invites, reviews) {
  let out =
`OVERVIEW
--------
Total emails processed: ${total}

Interview invitations (confirmed): ${counts.interview}
Auto replies: ${counts.auto_reply}
Other emails: ${counts.other}
Needs review (low confidence): ${counts.needs_review}


`;

  if (invites.length) {
    out += `INTERVIEW INVITATIONS (Action Required)\n---------------------------------------\n\n`;
    invites.forEach((x, i) => {
      out +=
`${i + 1}) ${x.company} — ${x.position}
   Contact: ${x.contact}
   Proposed times:
${x.proposed_times.length ? x.proposed_times.map(t => `     • ${t}`).join("\n") : "     • N/A"}
   Urgency: ${String(x.urgency).toUpperCase()}
   Confidence: ${x.confidence}
   Note:
   ${x.snippet}

`;
    });
  } else {
    out += `INTERVIEW INVITATIONS\n---------------------\nNo confirmed interview invitations detected.\n\n`;
  }

  if (reviews.length) {
    out +=
`NEEDS REVIEW (low-confidence items)
-----------------------------------
These items had confidence < ${LOW_CONF} and should be checked manually.

`;
    reviews.forEach((x, i) => {
      out +=
`${i + 1}) [${x.id}] Category: ${x.category} | Confidence: ${x.confidence}
   Company: ${x.company || "(unknown)"}
   Position: ${x.position || "(unknown)"}
   Contact: ${x.contact || "(unknown)"}
   Proposed times: ${x.proposed_times && x.proposed_times.length ? x.proposed_times.join(", ") : "N/A"}
   Note: ${x.snippet}

`;
    });
  }

  out +=
`SUMMARY OF NON-ACTIONABLE EMAILS
--------------------------------
Auto replies (system / no-reply): ${counts.auto_reply}
Other topics (updates, rejections, misc): ${counts.other}
`;
  return out;
}

function inviteRow_(x, confidence) {
  const proposed = Array.isArray(x.proposed_times) ? x.proposed_times : (x.proposed_times ? [x.proposed_times] : []);
  return {
    id: x.id || "",
    company: x.company || "(unknown company)",
    position: x.position || "(unknown position)",
    contact: x.contact || "(unknown contact)",
    proposed_times: proposed,
    urgency: x.urgency || "normal",
    confidence: confidence,
    snippet: sanitizeText_(x.snippet || "")
  };
}

function minRow_(x, confidence, category) {
  const proposed = Array.isArray(x.proposed_times) ? x.proposed_times : (x.proposed_times ? [x.proposed_times] : []);
  return {
    id: x.id || "",
    category: category,
    company: x.company || "",
    position: x.position || "",
    contact: x.contact || "",
    proposed_times: proposed,
    confidence: confidence,
    snippet: sanitizeText_(x.snippet || "")
  };
}

// Small extra defense: redact obvious numeric codes if they slip through
function sanitizeText_(s) {
  const text = String(s || "").trim();
  // Replace sequences that look like OTP/codes (6-10 digits)
  return text.replace(/\b\d{6,10}\b/g, "[REDACTED]");
}

function getProp_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error(`Missing ${k} in Script Properties.`);
  return v;
}

function getOrCreateLabel_(name) {
  const label = GmailApp.getUserLabelByName(name);
  return label ? label : GmailApp.createLabel(name);
}

function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}


// ---------- CHANGE: Dedupe helpers ----------

function alertedKey_(threadId) {
  return `ALERTED_THREAD_${threadId}`;
}

function isThreadAlerted_(threadId) {
  const props = PropertiesService.getScriptProperties();
  return !!props.getProperty(alertedKey_(threadId));
}

function markThreadAlerted_(threadId) {
  const props = PropertiesService.getScriptProperties();
  // store timestamp for optional cleanup
  props.setProperty(alertedKey_(threadId), String(Date.now()));
}

// Delete old alert records to prevent unbounded growth
function cleanupOldAlertRecords_(keepDays) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  const ttlMs = (keepDays || 30) * 24 * 60 * 60 * 1000;

  Object.keys(all).forEach(k => {
    if (!k.startsWith("ALERTED_THREAD_")) return;
    const t = Number(all[k]);
    if (!isFinite(t)) return;
    if (now - t > ttlMs) props.deleteProperty(k);
  });
}
