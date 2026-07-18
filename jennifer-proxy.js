const http = require("http");
const https = require("https");
const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");

const _PORT = parseInt((process.env.PORT || "3090").trim(), 10);
const PORT = Number.isInteger(_PORT) && _PORT > 0 ? _PORT : 3090;
const SESSION_TTL = 30 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL = "mistralai/mistral-small-3.2-24b-instruct";
const ERIC_PHONE = "+14058182636";
const LEAD_TEXT_DELAY = Number(process.env.LEAD_TEXT_DELAY_MS || "240000");
const NTFY_URL = "https://ntfy.sh/AffordableSolarLeads";
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = "-1003773483505";
const TELEGRAM_ALERTS_THREAD = 3; // Sales topic
const PUSHOVER_API_TOKEN = (process.env.PUSHOVER_API_TOKEN || process.env.PUSHOVER_TOKEN || "").trim();
const PUSHOVER_USER_KEY = (process.env.PUSHOVER_USER_KEY || process.env.PUSHOVER_USER || "").trim();
const PUSHOVER_DEVICE = (process.env.PUSHOVER_DEVICE || "").trim();
const PUBLIC_BASE_URL = (process.env.JENNIFER_PUBLIC_BASE_URL || "https://jennifer-proxy.onrender.com").trim().replace(/\/+$/, "");
const LEAD_SUMMARY_ENABLED = !/^(0|false|off|no)$/i.test((process.env.LEAD_SUMMARY_ENABLED || "true").trim());
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || "qwen3:8b").trim();
const ENABLE_IMESSAGE = /^\s*(1|true|yes|on)\s*$/i.test((process.env.ENABLE_IMESSAGE || "false").trim());
const CHAT_HISTORY_FILE = path.resolve(
  process.env.JENNIFER_CHAT_HISTORY_FILE ||
    path.join(__dirname, "chat-history.jsonl")
);
const CHAT_LEADS_FILE = path.resolve(
  process.env.JENNIFER_CHAT_LEADS_FILE ||
    path.join(__dirname, "chat-leads.jsonl")
);
const CHAT_HISTORY_MAX_MESSAGES = Math.max(
  1,
  parseInt((process.env.JENNIFER_CHAT_HISTORY_MAX_MESSAGES || "500").trim(), 10) || 500
);
const CHAT_HISTORY_ENABLED = !/^(0|false|off|no)$/i.test(
  (process.env.JENNIFER_CHAT_HISTORY_ENABLED || "true").trim()
);
const CHAT_HISTORY_ACCESS_TOKEN = (process.env.CHAT_HISTORY_ACCESS_TOKEN || "").trim();
const NEW_CHAT_ALERTS_ENABLED = !/^(0|false|off|no)$/i.test(
  (process.env.JENNIFER_NEW_CHAT_ALERTS || "true").trim()
);

const systemPromptPath = [
  process.env.JENNIFER_SYSTEM_PROMPT_PATH,
  path.resolve(__dirname, "jennifer-system-prompt.txt"),
  path.resolve(process.cwd(), "jennifer-system-prompt.txt"),
].find((candidate) => {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate);
  } catch (_) {
    return false;
  }
});

if (!systemPromptPath) {
  throw new Error(
    "System prompt file missing. Set JENNIFER_SYSTEM_PROMPT_PATH to an existing file."
  );
}

const systemPrompt = fs.readFileSync(systemPromptPath, "utf8");

const sessions = new Map();
const historyBySession = new Map();
const leadsBySession = new Map();

// --- Conversation stages ---

const STAGES = {
  OPEN: 1,
  DISCOVER: 2,
  COLLECT_NAME: 3,
  COLLECT_PHONE: 4,
  COLLECT_TIME: 5,
  CONFIRM: 6,
};

const STAGE_INSTRUCTIONS = {
  [STAGES.OPEN]:
    "STATE: OPEN. Answer the visitor's latest message first. The website widget already introduced Jennifer, so do not introduce her again unless the visitor asks who they are talking to. Ask at most one useful follow-up.",
  [STAGES.DISCOVER]:
    "STATE: CONVERSATION. Answer the visitor's latest question, correction, or concern directly. Do not assume a premise they did not state. Ask at most one relevant follow-up, and only when it helps.",
  [STAGES.COLLECT_NAME]:
    "CALLBACK STATE: The visitor accepted a callback and their name is missing. Answer their latest message first. If they did not interrupt the callback, ask for their name in one short sentence.",
  [STAGES.COLLECT_PHONE]:
    "CALLBACK STATE: The visitor accepted a callback and their phone number is missing. Answer their latest message first. If they did not interrupt the callback, ask for the best number to reach them in one short sentence.",
  [STAGES.COLLECT_TIME]:
    "CALLBACK STATE: The visitor accepted a callback and their preferred time is missing. Answer their latest message first. If they did not interrupt the callback, ask what time of day is best in one short sentence.",
  [STAGES.CONFIRM]:
    "CALLBACK STATE: Name, phone, and preferred time are confirmed. Answer the latest message first, then briefly confirm that Eric will reach out. The conversation remains open for questions.",
};

function isGenericGreeting(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+/g, "")
    .replace(/\s+/g, " ");

  if (!normalized) return false;

  return /^(?:hi|hey|hello|howdy|hiya|yo|sup|good morning|good afternoon|good evening)$/.test(normalized);
}

function isDirectCallRequest(text) {
  const value = String(text || "");
  if (isIdentityQuestion(value)) return false;
  if (/\b(?:do not|don't|dont|never|no longer)\b[^.!?]{0,60}\b(?:call|phone number|talk|speak|contact|real person|human)\b/i.test(value)) return false;
  return /\b(?:can i call|just call|rather call|want to call|call (?:you|the office)|(?:what(?:'s| is)|give me|send me) (?:your|the office) (?:phone )?number|what number (?:can|should) i call|(?:can i |let me |want to |rather )?(?:talk|speak) to (?:someone|a person|a real person|a human)|real person please)\b/i.test(value);
}

function getDirectCallResponse() {
  return "You can call us at (405) 400-2836.";
}

function isIdentityQuestion(text) {
  const value = String(text || "");
  return /\b(?:are you|is this)\b[^.!?]{0,50}\b(?:ai|bot|chatbot|human|real person)\b/i.test(value) ||
    /\b(?:who|what) (?:am i|are we) (?:talking|chatting) (?:to|with)\b/i.test(value);
}

function getIdentityResponse() {
  return "I'm Affordable Solar's AI website assistant. I can help here, or arrange a callback from Eric if you'd rather speak with a person.";
}

function isHistoryAuthorized(queryParams, res) {
  if (!CHAT_HISTORY_ACCESS_TOKEN) return true;
  const token = queryParams.get("token") || "";
  if (token === CHAT_HISTORY_ACCESS_TOKEN) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
}

function historyUiUrl() {
  const url = new URL("/history-ui", PUBLIC_BASE_URL);
  if (CHAT_HISTORY_ACCESS_TOKEN) {
    url.searchParams.set("token", CHAT_HISTORY_ACCESS_TOKEN);
  }
  return url.toString();
}

const INTENTS = {
  EQUIPMENT: "equipment research",
  PRICE: "price shopper",
  HIGH_BILL: "high bill",
  BATTERY: "battery/outage",
  OFF_GRID: "off-grid/energy independence",
  QUOTE_SHOPPER: "already has quotes",
  SKEPTIC: "skeptic",
  COMMERCIAL: "commercial",
  NEW_BUILD: "new build",
  RENTER: "renter",
  DIRECT_CALL: "direct call",
  CURIOUS: "curious",
};

function classifyIntent(text) {
  const value = String(text || "");
  if (!value.trim()) return INTENTS.CURIOUS;
  if (/\b(cost|price|pricing|how much|expensive|afford|payment|finance|financing)\b/i.test(value)) return INTENTS.PRICE;
  if (isDirectCallRequest(value)) return INTENTS.DIRECT_CALL;
  if (/\b(quote|quoted|quotes|bid|bids|proposal|proposals|another company|other companies|shopping around)\b/i.test(value)) return INTENTS.QUOTE_SHOPPER;
  if (/\b(off.?grid|energy independence|independent of (?:the )?(?:grid|power company|utility)|self.?sufficient|(?:do not|don't|dont|not) (?:want to )?rely on (?:a |the )?(?:grid|power company|utility))\b/i.test(value)) return INTENTS.OFF_GRID;
  if (/\b(battery|batteries|backup|outage|outages|grid goes down|storm|ice storm|power went out|generator)\b/i.test(value)) return INTENTS.BATTERY;
  if (/\b(enphase|microinverter|micro.?inverter|inverter|panel|panels|tesla|powerwall|franklin|eg4|ironridge|gaf|battery brand|equipment|warranty|hail)\b/i.test(value)) return INTENTS.EQUIPMENT;
  if (/\b(commercial|business|warehouse|office|shop|facility|church|farm|my company|our company)\b/i.test(value)) return INTENTS.COMMERCIAL;
  if (/\b(new build|new construction|building a|building my|builder|new house|custom home)\b/i.test(value)) return INTENTS.NEW_BUILD;
  if (/\b(rent|renter|landlord|apartment|lease)\b/i.test(value)) return INTENTS.RENTER;
  if (/\b(scam|rip.?off|waste of money|does it actually save|catch|too good to be true)\b/i.test(value)) return INTENTS.SKEPTIC;
  if (/\b(high bill|bill|bills|paying|electric.*killing|rate|rates|OGE|OG&E|PSO)\b/i.test(value)) return INTENTS.HIGH_BILL;
  return INTENTS.CURIOUS;
}

function detectIntent(messages) {
  const userMessages = messages.filter((message) => message.role === "user");
  for (let index = userMessages.length - 1; index >= 0; index--) {
    const intent = classifyIntent(userMessages[index].content);
    if (intent !== INTENTS.CURIOUS) return intent;
  }
  return INTENTS.CURIOUS;
}

function isVagueUserMessage(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+/g, "")
    .replace(/\s+/g, " ");
  return /^(?:solar|not sure|idk|i dont know|i don't know|just looking|just looking around|curious|maybe|checking|checking around|browsing|researching)$/.test(normalized);
}

function extractReasonRaw(messages) {
  const userMessages = messages.filter((message) => message.role === "user").reverse();
  for (const message of userMessages) {
    const text = String(message.content || "").trim();
    if (!text || isGenericGreeting(text) || isVagueUserMessage(text)) continue;
    if (/\?|^(?:who|what|when|where|why|how|do|does|did|is|are|can|could|would|will|should)\b/i.test(text)) continue;
    if (extractPhone(text)) continue;
    if (/^(?:OGE|OG&E|PSO|co-?op)$/i.test(text)) continue;
    if (/^\$?\d{2,4}(?:\s*(?:a month|monthly|\/mo|per month))?$/i.test(text)) continue;
    if (/^(?:morning|mornings|afternoon|afternoons|evening|evenings|anytime|any time|after lunch|\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i.test(text)) continue;
    const selfIdentification = text.match(
      /^(?:my name is|call me)\s+([^,.!?]+)[,.!?]?$/i
    );
    if (selfIdentification && looksLikeName(selfIdentification[1])) continue;
    if (/^(?:house|home|warehouse|business)\s+(?:in|near)\b/i.test(text)) continue;
    return text.slice(0, 300);
  }
  return null;
}

function scoreLead(messages, context, leadData) {
  const intent = detectIntent(messages);
  const allUserText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  let points = 0;
  const reasons = [];

  if (leadData.phone) {
    points += 3;
    reasons.push("phone captured");
  }
  if (leadData.name) {
    points += 1;
    reasons.push("name captured");
  }
  if (leadData.time) {
    points += 1;
    reasons.push("call time captured");
  }
  if (context.bill) {
    points += 2;
    reasons.push("bill shared");
  }
  if (context.utility) {
    points += 1;
    reasons.push("utility shared");
  }
  if (intent === INTENTS.QUOTE_SHOPPER) {
    points += 3;
    reasons.push("already comparing quotes");
  }
  if (intent === INTENTS.BATTERY) {
    points += 2;
    reasons.push("battery or outage need");
  }
  if (intent === INTENTS.COMMERCIAL) {
    points += 2;
    reasons.push("commercial inquiry");
  }
  if (intent === INTENTS.DIRECT_CALL) {
    points += 2;
    reasons.push("asked to speak with someone");
  }
  if (/\b(ready|asap|soon|this week|today|tomorrow|go ahead|let's do it|lets do it)\b/i.test(allUserText)) {
    points += 2;
    reasons.push("urgency or buying signal");
  }

  const label = points >= 7 ? "HOT" : points >= 4 ? "WARM" : "CASUAL";
  return { label, points, intent, reasons };
}

function trimHistory(messages) {
  if (messages.length <= CHAT_HISTORY_MAX_MESSAGES) return messages;
  return messages.slice(messages.length - CHAT_HISTORY_MAX_MESSAGES);
}

function loadHistoryFromDisk() {
  if (!CHAT_HISTORY_ENABLED) {
    console.log("Chat history logging disabled");
    return;
  }

  try {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    const raw = fs.readFileSync(CHAT_HISTORY_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (
          !parsed ||
          typeof parsed.sessionId !== "string" ||
          typeof parsed.role !== "string" ||
          typeof parsed.content !== "string"
        ) {
          continue;
        }
        const messages = historyBySession.get(parsed.sessionId) || [];
        messages.push({
          role: parsed.role,
          content: parsed.content,
          at: parsed.at || new Date().toISOString(),
        });
        historyBySession.set(parsed.sessionId, trimHistory(messages));
      } catch (err) {
        console.error("Skipping invalid history line:", err.message);
      }
    }
    console.log("Loaded chat history sessions:", historyBySession.size);
  } catch (err) {
    console.error("Failed to load chat history:", err.message);
  }
}

function loadLeadsFromDisk() {
  try {
    if (!fs.existsSync(CHAT_LEADS_FILE)) return;
    const raw = fs.readFileSync(CHAT_LEADS_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed.sessionId !== "string") continue;
        leadsBySession.set(parsed.sessionId, parsed);
      } catch (err) {
        console.error("Skipping invalid lead line:", err.message);
      }
    }
    console.log("Loaded chat leads:", leadsBySession.size);
  } catch (err) {
    console.error("Failed to load chat leads:", err.message);
  }
}

function hasHistoryRecord(sessionId, role, content, at) {
  const messages = historyBySession.get(sessionId) || [];
  return messages.some(
    (message) =>
      message.role === role &&
      message.content === content &&
      (!at || message.at === at)
  );
}

function storeHistoryMessage(sessionId, role, content, atOverride) {
  if (!CHAT_HISTORY_ENABLED || !sessionId) return;

  const messages = historyBySession.get(sessionId) || [];
  const at = atOverride || new Date().toISOString();
  if (hasHistoryRecord(sessionId, role, content, at)) return;
  messages.push({ role, content, at });
  historyBySession.set(sessionId, trimHistory(messages));

  const record = JSON.stringify({ sessionId, role, content, at }) + "\n";
  fs.appendFile(CHAT_HISTORY_FILE, record, (err) => {
    if (err) {
      console.error("History write error:", err.message);
    }
  });
}

function importHistoryRecords(records) {
  let imported = 0;
  let skipped = 0;

  for (const record of records) {
    if (!record || typeof record !== "object") {
      skipped++;
      continue;
    }

    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const role = typeof record.role === "string" ? record.role.trim() : "";
    const content = typeof record.content === "string" ? record.content : "";
    const at = typeof record.at === "string" && record.at.trim() ? record.at.trim() : undefined;

    if (!sessionId || !role || !content) {
      skipped++;
      continue;
    }

    if (hasHistoryRecord(sessionId, role, content, at)) {
      skipped++;
      continue;
    }

    storeHistoryMessage(sessionId, role, content, at);
    imported++;
  }

  return { imported, skipped, sessions: historyBySession.size };
}

function storeLeadRecord(lead) {
  if (!lead || !lead.sessionId) return false;

  leadsBySession.set(lead.sessionId, lead);
  const record = JSON.stringify(lead) + "\n";
  fs.appendFile(CHAT_LEADS_FILE, record, (err) => {
    if (err) {
      console.error("Lead write error:", err.message);
    }
  });
  return true;
}

function getLeadsPayload() {
  return Array.from(leadsBySession.values()).sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

function getStoredSessionMessages(sessionId) {
  if (!CHAT_HISTORY_ENABLED || !sessionId) return [];
  return (historyBySession.get(sessionId) || []).slice();
}

function getHistoryPayload(sessionId) {
  return getStoredSessionMessages(sessionId);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHistoryUi(token) {
  const tokenQuery = token ? "?token=" + encodeURIComponent(token) : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jennifer Chat History</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --panel: #ffffff;
      --ink: #1d2423;
      --muted: #66736f;
      --line: #d9ded9;
      --accent: #176b5d;
      --accent-soft: #dcebe6;
      --user: #eaf3ef;
      --assistant: #f7f0df;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, var(--bg) 0%, #ebe8dd 100%);
      color: var(--ink);
    }
    header {
      padding: 22px 24px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.76);
      position: sticky;
      top: 0;
      z-index: 2;
      backdrop-filter: blur(12px);
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 720;
    }
    .meta {
      color: var(--muted);
      margin-top: 5px;
      font-size: 13px;
    }
    main {
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
      min-height: calc(100vh - 74px);
    }
    aside {
      border-right: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.58);
      overflow: auto;
      max-height: calc(100vh - 74px);
    }
    .session {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      color: inherit;
      padding: 14px 16px;
      text-align: left;
      cursor: pointer;
      display: block;
    }
    .session:hover,
    .session.active { background: var(--accent-soft); }
    .sid {
      font-size: 13px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .last {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .count {
      margin-top: 6px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    section {
      padding: 24px;
      overflow: auto;
      max-height: calc(100vh - 74px);
    }
    .empty,
    .error {
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 18px;
      border-radius: 8px;
      color: var(--muted);
    }
    .error { color: #8f2d21; }
    .message {
      max-width: 780px;
      margin: 0 0 12px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .message.user { background: var(--user); }
    .message.assistant { background: var(--assistant); }
    .role {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .lead {
      max-width: 780px;
      margin-bottom: 18px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.7);
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 760px) {
      main { grid-template-columns: 1fr; }
      aside {
        max-height: 260px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      section { max-height: none; padding: 16px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Jennifer Chat History</h1>
    <div class="meta" id="status">Loading sessions...</div>
  </header>
  <main>
    <aside id="sessions"></aside>
    <section id="detail"><div class="empty">Select a chat to view the conversation.</div></section>
  </main>
  <script>
    const tokenQuery = ${JSON.stringify(tokenQuery)};
    const sessionsEl = document.getElementById("sessions");
    const detailEl = document.getElementById("detail");
    const statusEl = document.getElementById("status");

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    async function loadJson(url) {
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) throw new Error("History access token required");
        throw new Error(text || response.statusText);
      }
      return text ? JSON.parse(text) : {};
    }

    async function loadSessions() {
      try {
        const data = await loadJson("/history" + tokenQuery);
        const sessions = data.sessions || [];
        statusEl.textContent = sessions.length + " session" + (sessions.length === 1 ? "" : "s");
        if (!sessions.length) {
          sessionsEl.innerHTML = '<div class="empty">No chat history has been recorded yet.</div>';
          return;
        }
        sessionsEl.innerHTML = sessions.map((session, index) => {
          const last = session.lastMessage || {};
          return '<button class="session' + (index === 0 ? ' active' : '') + '" data-session-id="' + escapeHtml(session.sessionId) + '">' +
            '<div class="sid">' + escapeHtml(session.sessionId) + '</div>' +
            '<div class="last">' + escapeHtml(last.content || "") + '</div>' +
            '<div class="count">' + escapeHtml(session.count) + ' messages</div>' +
          '</button>';
        }).join("");
        sessionsEl.querySelectorAll(".session").forEach((button) => {
          button.addEventListener("click", () => {
            sessionsEl.querySelectorAll(".session").forEach((el) => el.classList.remove("active"));
            button.classList.add("active");
            loadSession(button.dataset.sessionId);
          });
        });
        loadSession(sessions[0].sessionId);
      } catch (err) {
        statusEl.textContent = "Unable to load history";
        detailEl.innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
      }
    }

    async function loadSession(sessionId) {
      detailEl.innerHTML = '<div class="empty">Loading chat...</div>';
      try {
        const separator = tokenQuery ? "&" : "?";
        const data = await loadJson("/history" + tokenQuery + separator + "sessionId=" + encodeURIComponent(sessionId));
        const lead = data.leadData || {};
        const leadHtml = '<div class="lead">' +
          '<strong>' + escapeHtml(data.sessionId) + '</strong><br>' +
          'Name: ' + escapeHtml(lead.name || "unknown") + ' | Phone: ' + escapeHtml(lead.phone || "unknown") +
          ' | Utility: ' + escapeHtml(lead.utility || "unknown") + ' | Bill: ' + escapeHtml(lead.bill || "unknown") +
        '</div>';
        const messagesHtml = (data.messages || []).map((message) =>
          '<div class="message ' + escapeHtml(message.role) + '">' +
            '<span class="role">' + escapeHtml(message.role) + '</span>' +
            escapeHtml(message.content) +
          '</div>'
        ).join("");
        detailEl.innerHTML = leadHtml + (messagesHtml || '<div class="empty">This session has no messages.</div>');
      } catch (err) {
        detailEl.innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
      }
    }

    loadSessions();
  </script>
</body>
</html>`;
}

function getLatestUserMessage(messages) {
  return [...messages].reverse().find((message) => message.role === "user") || null;
}

function isCallbackWithdrawal(text) {
  return /\b(?:do not|don't|dont|never mind|nevermind|cancel)\b[^.!?]{0,40}\b(?:call|contact|reach out|callback)\b|\b(?:do not|don't|dont) call me\b/i.test(
    String(text || "")
  );
}

function isConversationInterruption(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return isIdentityQuestion(value) ||
    value.includes("?") ||
    /^(?:no\b|actually\b|i mean\b|that's not\b|that isn't\b|you misunderstood\b|not what i\b)/i.test(value) ||
    /\b(?:not sure|hold on|one sec|give me a minute|let me think|not ready|maybe later|another question|no thanks|not interested)\b/i.test(value);
}

const CALLBACK_OFFER_PATTERNS = [
  /\bwould you like to (?:speak|talk) (?:to|with) (?:Eric|an? advisor|someone)\b/i,
  /\bwould you like\b[^.!?]{0,60}\b(?:Eric|an? advisor|someone)\b[^.!?]{0,40}\b(?:call|contact|reach out)\b/i,
  /\b(?:i|we) can have\b[^.!?]{0,30}\b(?:Eric|an? advisor|someone)\b[^.!?]{0,30}\b(?:call|contact|reach out)\b/i,
  /\b(?:Eric|an? advisor|someone)\b[^.!?]{0,30}\b(?:can|could|will|would)\b[^.!?]{0,20}\b(?:call|contact|reach out)\b/i,
  /\b(?:would you )?(?:want|like) (?:a )?callback\b/i,
  /\b(?:i|we) can arrange (?:a )?(?:call|callback)\b/i,
  /\b(?:(?:i|we)(?:'d| would) be happy to )?arrange (?:a )?(?:call|callback)\b/i,
];

const CONTACT_COLLECTION_PATTERNS = [
  /\bwhat(?:'s| is) your (?:full )?name\b/i,
  /\b(?:can|could|may) i (?:get|have) your (?:phone |cell |mobile )?number\b/i,
  /\bwhat(?:'s| is) (?:the )?best (?:phone |cell |mobile )?number to (?:call|reach|contact) you\b/i,
  /\bwhat(?:'s| is) your (?:phone|cell|mobile) number\b/i,
  /\bwhat time\b[^.!?]{0,40}\b(?:Eric|call|reach|contact)\b/i,
  /\byou can (?:call|reach|contact) (?:us|Eric) at\b/i,
  /\b(?:our|the office) (?:phone )?number is\b/i,
  /\(405\)\s*400[- ]2836\b/i,
];

function firstPatternIndex(text, patterns) {
  let first = -1;
  for (const pattern of patterns) {
    const index = String(text || "").search(pattern);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  return first;
}

function assistantOfferedCallback(text) {
  return firstPatternIndex(text, CALLBACK_OFFER_PATTERNS) >= 0;
}

function removeUnrequestedCallbackOffer(text, session) {
  const latestUserText = getLatestUserMessage(session?.messages || [])?.content || "";
  if (
    session?.callbackAccepted ||
    isIdentityQuestion(latestUserText) ||
    isDirectCallRequest(latestUserText) ||
    explicitlyAcceptsCallback(latestUserText)
  ) {
    return String(text || "").trim();
  }

  const segments = String(text || "").match(/[^.!?]+[.!?]?/g) || [];
  return segments
    .map((segment) => {
      const callbackIndex = firstPatternIndex(segment, CALLBACK_OFFER_PATTERNS);
      const collectionIndex = firstPatternIndex(segment, CONTACT_COLLECTION_PATTERNS);
      const indexes = [callbackIndex, collectionIndex].filter((index) => index >= 0);
      if (indexes.length === 0) return segment.trim();

      const prefix = segment
        .slice(0, Math.min(...indexes))
        .replace(/[\s,;:]+$/, "")
        .trim();
      if (!prefix) return "";
      return /[.!?]$/.test(prefix) ? prefix : prefix + ".";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function explicitlyAcceptsCallback(text) {
  const value = String(text || "");
  if (isDirectCallRequest(value)) return false;
  const callMeName = value.match(/^call me\s+([^,.!?]+)[,.!?]?$/i);
  if (callMeName && !extractPhone(value) && looksLikeName(callMeName[1])) return false;
  return /\b(?:call me|give me a call|have (?:Eric|him|someone) call me|you can call me|please call me|i(?:'d| would) like (?:a )?call|reach out to me|contact me)\b/i.test(value);
}

function inferCallbackAcceptance(messages) {
  let accepted = false;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user") continue;

    const text = String(message.content || "");
    if (isCallbackWithdrawal(text)) {
      accepted = false;
      continue;
    }
    if (explicitlyAcceptsCallback(text)) {
      accepted = true;
      continue;
    }

    const previous = messages[index - 1];
    if (
      extractPhone(text) &&
      previous?.role === "assistant" &&
      assistantOfferedCallback(previous.content)
    ) {
      accepted = true;
      continue;
    }
    const directName = text
      .trim()
      .replace(/^(?:my name is|i'm|i am|this is|call me)\s+/i, "")
      .replace(/[.!,]+$/, "")
      .trim();
    if (
      previous?.role === "assistant" &&
      assistantOfferedCallback(previous.content) &&
      (/^(?:yes|yeah|yep|sure|okay|ok|go ahead|sounds good)\b/i.test(text.trim()) ||
        (/\b(?:what's your name|your name|name and number)\b/i.test(previous.content) &&
          !isConversationInterruption(text) &&
          looksLikeName(directName)))
    ) {
      accepted = true;
    }
  }
  return accepted;
}

function captureLeadFields(session) {
  session.leadData = session.leadData || { name: null, phone: null, time: null };
  const inferredAcceptance = inferCallbackAcceptance(session.messages);

  if (session.callbackAccepted == null) {
    session.callbackAccepted =
      (session.stage >= STAGES.COLLECT_NAME && session.stage <= STAGES.CONFIRM) ||
      inferredAcceptance;
  } else if (inferredAcceptance) {
    session.callbackAccepted = true;
  }

  if (!session.callbackAccepted) return;

  const name = extractName(session.messages);
  const phone = extractPhoneFromSession(session);
  const time = extractTime(session.messages);
  if (name) session.leadData.name = name;
  if (phone) session.leadData.phone = phone;
  if (time) session.leadData.time = time;
}

function getStage(session) {
  captureLeadFields(session);

  if (session.callbackAccepted) {
    if (session.leadData.name && session.leadData.phone && session.leadData.time) {
      return session.callbackConfirmed ? STAGES.DISCOVER : STAGES.CONFIRM;
    }
    if (!session.leadData.name) return STAGES.COLLECT_NAME;
    if (!session.leadData.phone) return STAGES.COLLECT_PHONE;
    return STAGES.COLLECT_TIME;
  }

  const userMessages = session.messages.filter((message) => message.role === "user");
  if (userMessages.length === 1 && isGenericGreeting(userMessages[0].content)) return STAGES.OPEN;
  return userMessages.length ? STAGES.DISCOVER : STAGES.OPEN;
}

function getActiveStage(session) {
  if (!session) return STAGES.OPEN;

  const latestUser = getLatestUserMessage(session.messages);
  const latestText = latestUser?.content || "";
  if (isCallbackWithdrawal(latestText)) {
    session.callbackAccepted = false;
    session.callbackConfirmed = false;
    if (session.leadTextTimer) {
      clearTimeout(session.leadTextTimer);
      session.leadTextTimer = null;
    }
    return STAGES.DISCOVER;
  }

  const stage = getStage(session);
  if (isConversationInterruption(latestText)) return STAGES.DISCOVER;

  session.stage = stage;
  return stage;
}

// --- Session management ---

function getSession(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (session) {
    session.lastAccess = Date.now();
    return session;
  }
  const storedMessages = getStoredSessionMessages(sessionId);
  const lastMessageAt =
    storedMessages.length > 0 && storedMessages[storedMessages.length - 1].at
      ? Date.parse(storedMessages[storedMessages.length - 1].at)
      : 0;
  const shouldReuseHistory =
    storedMessages.length > 0 && Date.now() - lastMessageAt < SESSION_TTL;
  const initialMessages = shouldReuseHistory ? storedMessages : [];
  const storedCallbackAccepted = shouldReuseHistory
    ? inferCallbackAcceptance(storedMessages)
    : false;
  const storedName = storedCallbackAccepted ? extractName(storedMessages) : null;
  const storedPhone = storedCallbackAccepted
    ? extractPhoneFromSession({ messages: storedMessages })
    : null;
  const storedTime = storedCallbackAccepted ? extractTime(storedMessages) : null;
  const newSession = {
    messages: initialMessages,
    lastAccess: Date.now(),
    leadSent: shouldReuseHistory
      ? Boolean(storedName && storedPhone && storedTime)
      : false,
    leadData: { name: storedName, phone: storedPhone, time: storedTime },
    callbackAccepted: storedCallbackAccepted,
    callbackConfirmed: Boolean(storedName && storedPhone && storedTime),
    stage: STAGES.OPEN,
    newChatNotified: false,
    startedAt: Date.now(),
    sessionId,
  };
  sessions.set(sessionId, newSession);
  return newSession;
}

function startSessionCleanup() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > SESSION_TTL) {
        sessions.delete(id);
      }
    }
  }, CLEANUP_INTERVAL);
  timer.unref();
}

// --- Post-processing ---

function normalizeReplyText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
}

function getQuestionClauses(text) {
  return String(text || "")
    .split("?")
    .slice(0, -1)
    .map((part) => normalizeReplyText(part.split(/[.!]/).pop()))
    .filter(Boolean);
}

function isRepeatedReply(currentText, messages) {
  const current = normalizeReplyText(currentText);
  if (!current) return false;
  const currentQuestions = getQuestionClauses(currentText);

  for (const message of messages || []) {
    if (message.role !== "assistant") continue;
    if (normalizeReplyText(message.content) === current) return true;

    const previousQuestions = new Set(getQuestionClauses(message.content));
    if (currentQuestions.some((question) => previousQuestions.has(question))) return true;
  }
  return false;
}

function removeRepeatedQuestions(text, messages) {
  const previousQuestions = new Set(
    (messages || [])
      .filter((message) => message.role === "assistant")
      .flatMap((message) => getQuestionClauses(message.content))
  );
  if (previousQuestions.size === 0) return String(text || "").trim();

  return String(text || "")
    .replace(
      /(^|[.!]\s+|,\s+)((?:what|why|how|who|when|where|do|does|did|is|are|can|could|would|will|should|may)\b[^?]*\?)/gi,
      (match, prefix, question) => {
        if (!previousQuestions.has(normalizeReplyText(question))) return match;
        if (prefix.startsWith(",")) return ".";
        if (prefix.startsWith(".") || prefix.startsWith("!")) return prefix[0];
        return "";
      }
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\.{2,}/g, ".")
    .trim();
}

function needsModelRetry(cleanedText, messages) {
  return !String(cleanedText || "").trim() || isRepeatedReply(cleanedText, messages);
}

function getNonRepeatedRecovery(messages) {
  const candidates = [
    "I didn't answer that well. Could you rephrase your latest question?",
    "I lost the thread. What should I answer first?",
    "I missed your point. What would you like me to address?",
  ];
  const available = candidates.find((candidate) => !isRepeatedReply(candidate, messages));
  if (available) return available;

  let recovery = "I need a fresh wording before I can answer accurately.";
  while (isRepeatedReply(recovery, messages)) {
    recovery += " Please rephrase it.";
  }
  return recovery;
}

function stripEmojis(text) {
  return text
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

function postProcess(text, _stage, session) {
  let result = stripEmojis(text);
  const messages = session ? session.messages : [];
  const allUserText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");

  // Strip em dashes
  result = result.replace(/\u2014/g, ",").replace(/--/g, ",");

  // Do not reintroduce Jennifer after the widget greeting.
  if (!isIdentityQuestion(getLatestUserMessage(messages)?.content)) {
    result = result
      .replace(/^\s*(?:hi|hey|hello)(?: there)?,?\s*i['’]?m jennifer(?: with affordable solar(?: in norman)?)?\.?\s*/gi, "")
      .replace(/\bi['’]?m jennifer(?: with affordable solar(?: in norman)?)?\.?\s*/gi, "")
      .trim();
  }

  if (
    isIdentityQuestion(getLatestUserMessage(messages)?.content) &&
    /\b(?:(?:i am|i'm|we are|we're) (?:a )?(?:real person|human)|(?:i am|i'm|we are|we're) not (?:an? )?(?:ai|bot|chatbot)|not (?:an? )?(?:ai|bot|chatbot))\b/i.test(result)
  ) {
    result = getIdentityResponse();
  }

  // Strip address/zip asks from any stage
  result = result.replace(/[^.!?]*\b(?:your address|your zip|zip code|share your address|what's your address)\b[^.!?]*[.!?]?/gi, "").trim();

  // Strip link/form/online-scheduling mentions (but NOT casual time preference questions)
  result = result.replace(/[^.!?]*\b(?:send you a link|text you a link|quote form|schedule (?:a )?(?:consultation|visit|appointment)|sign up for|fill out|online calendar|booking link)\b[^.!?]*[.!?]?/gi, "").trim();

  // The site can offer an office call or callback, not a live transfer.
  result = result.replace(/[^.!?]*\b(?:connect you (?:now|live|directly)|transfer you|put you through)\b[^.!?]*[.!?]?/gi, "").trim();

  // A callback is a consented handoff, not a default discovery question.
  result = removeUnrequestedCallbackOffer(result, session);

  // Strip ITC/tax credit mentions
  result = result.replace(/[^.!?]*\b(?:ITC|tax credit|federal incentive|federal tax|investment tax)\b[^.!?]*[.!?]?/gi, "").trim();

  // Prevent unsupported technical, sizing, offset, and hail/stat claims from sounding verified.
  result = result
    .replace(/[^.!?]*\b\d+\s*[- ]?panel system\b[^.!?]*[.!?]?/gi, "")
    .replace(/[^.!?]*\b(?:offset percentage|100%\s*offset)\b[^.!?]*[.!?]?/gi, "")
    .replace(/[^.!?]*\bwe(?:'|’)?ve yet to see\b[^.!?]*[.!?]?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (/\bhail\b/i.test(allUserText)) {
    result = result
      .replace(/[^.!?]*\b\d+(?:\.\d+)?\s*(?:\"|inches?|mph|systems?|years?)\b[^.!?]*[.!?]?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Keep at most one question.
  const qMarks = (result.match(/\?/g) || []).length;
  if (qMarks > 1) {
    result = result.substring(0, result.indexOf("?") + 1);
  }

  // Enforce max 3 sentences
  const sentences = result.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length > 3) {
    result = sentences.slice(0, 3).join(" ");
  }

  return result.trim();
}

// --- Lead extraction ---

function extractPhone(text) {
  const patterns = [/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/, /\d{10}/];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length === 10) return digits;
    }
  }
  return null;
}

function extractPhoneFromSession(session) {
  for (const msg of session.messages) {
    if (msg.role === "user") {
      const p = extractPhone(msg.content);
      if (p) return p;
    }
  }
  return null;
}

function looksLikeName(text) {
  const value = String(text || "").trim();
  if (!value || value.length >= 40 || /[?\d]/.test(value)) return false;
  if (value.split(/\s+/).length > 3) return false;
  if (!/^[a-zA-Z][a-zA-Z\s.\-']*$/.test(value)) return false;
  return !/\b(?:solar|panel|panels|battery|backup|fridge|curious|interested|looking|ready|later|maybe|really|oge|og&e|pso|co-op|yes|no|yeah|nah|sure|okay|ok|cost|price|bill|home|house|business|off|grid|trying|want|wanting|in|from|at|after|before|tomorrow|today|morning|afternoon|evening|night|lunch|work|independent|without|lower|lowering|my|our|your|the|a|an|tulsa|norman|okc|edmond|moore|oklahoma)\b/i.test(value);
}

function formatName(text) {
  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function extractName(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const match = String(message.content || "")
      .trim()
      .match(/^(?:my name is|call me)\s+([^,.!?]+)[,.!?]?$/i);
    const candidate = match?.[1]?.trim();
    if (candidate && looksLikeName(candidate)) return formatName(candidate);
  }

  for (let index = messages.length - 1; index >= 1; index--) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (
      previous.role !== "assistant" ||
      current.role !== "user" ||
      !/(?:what's your (?:first )?name|your name\??$|who am i talking|name and number|share your name)/i.test(previous.content)
    ) {
      continue;
    }

    const text = String(current.content || "").trim();
    if (isConversationInterruption(text) || extractPhone(text)) continue;
    const candidate = text
      .replace(/^(?:my name is|i'm|i am|this is|call me)\s+/i, "")
      .replace(/[.!,]+$/, "")
      .trim();
    if (looksLikeName(candidate)) return formatName(candidate);
  }

  return null;
}

function extractTime(messages) {
  for (let index = messages.length - 1; index >= 1; index--) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (
      previous.role !== "assistant" ||
      current.role !== "user" ||
      !isCallbackTimeQuestion(previous.content)
    ) {
      continue;
    }

    const text = String(current.content || "").trim().toLowerCase();
    if (!text || isConversationInterruption(text) || extractPhone(text)) continue;
    if (/^(?:morning|mornings)$/.test(text)) return "mornings";
    if (/^(?:afternoon|afternoons)$/.test(text)) return "afternoons";
    if (/^(?:evening|evenings|night|nights)$/.test(text)) return "evenings";
    if (/^(?:after lunch|before lunch|after work)$/.test(text)) return text;
    if (/^(?:anytime|any time|whenever)$/.test(text)) return "anytime";
    const clockTime = text.match(/^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i);
    if (clockTime) return clockTime[0];
  }
  return null;
}

function isCallbackTimeQuestion(text) {
  const value = String(text || "");
  if (!value.includes("?")) return false;
  return /\bwhat time(?: of day|['’]s| is)?\b|\bwhen\b[^?]{0,50}\b(?:call|reach|catch)\b|\bmornings?\s+or\s+afternoons?\b|\b(?:morning|afternoon|evening)s?\b[^?]{0,30}\b(?:better|best|work)\b/i.test(value);
}

function extractContext(messages) {
  const context = {
    utility: null,
    bill: null,
    motivation: null,
    propertyType: null,
    homeowner: null,
    city: null,
    urgency: null,
  };
  const allUserText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase())
    .join(" ");

  if (/og&?e|oge/i.test(allUserText)) context.utility = "OG&E";
  else if (/pso/i.test(allUserText)) context.utility = "PSO";
  else if (/co-?op|rural|electric co/i.test(allUserText))
    context.utility = "Co-op";

  const billMatch = allUserText.match(
    /\$?\s*(\d{2,4})\s*(?:a month|\/month|per month|monthly|a mo)/i
  );
  if (billMatch) context.bill = "$" + billMatch[1] + "/mo";

  // Handle price ranges like "$300-400" — cap at 3 digits to avoid matching phone numbers
  if (!context.bill) {
    const rangeMatch = allUserText.match(/\$\s*(\d{2,3})\s*[-–]\s*\$?\s*(\d{2,3})\b/);
    if (rangeMatch) context.bill = "$" + rangeMatch[1] + "-" + rangeMatch[2] + "/mo";
  }

  for (let i = 1; i < messages.length; i++) {
    if (
      messages[i - 1].role === "assistant" &&
      messages[i].role === "user" &&
      /bill|monthly|running|paying|electric/i.test(messages[i - 1].content)
    ) {
      const amt = messages[i].content.match(/\$?\s*(\d{2,4})/);
      if (amt && !context.bill) context.bill = "$" + amt[1] + "/mo";
      // Also catch ranges in response to bill question
      const rangeAmt = messages[i].content.match(/\$?\s*(\d{2,4})\s*[-–]\s*\$?\s*(\d{2,4})/);
      if (rangeAmt && !context.bill) context.bill = "$" + rangeAmt[1] + "-" + rangeAmt[2] + "/mo";
    }
  }

  // Also detect bill from standalone numbers after bill-related context
  if (!context.bill) {
    const amt = allUserText.match(/(?:paying|bill|pay)\s+(?:like\s+|about\s+|around\s+)?\$?(\d{2,4})/i);
    if (amt) context.bill = "$" + amt[1] + "/mo";
  }

  const motivations = [];
  if (
    /high bill|expensive|too much|costs? a lot|paying too much|killing me/i.test(
      allUserText
    )
  )
    motivations.push("high bills");
  if (/outage|power out|blackout|storm|ice storm/i.test(allUserText))
    motivations.push("outages");
  if (/rate|increase|going up|keeps rising|went up/i.test(allUserText))
    motivations.push("rate increases");
  if (/environment|green|clean|carbon/i.test(allUserText))
    motivations.push("environmental");
  if (/off.?grid|independent|self.?sufficient/i.test(allUserText))
    motivations.push("energy independence");
  if (/batteries?|backup|power ?wall/i.test(allUserText))
    motivations.push("battery/backup");
  if (/tesla|ev|electric car|charger/i.test(allUserText))
    motivations.push("EV charging");
  if (/new (house|home|build|construction)/i.test(allUserText))
    motivations.push("new construction");
  if (/neighbor|referral|friend/i.test(allUserText))
    motivations.push("referral");
  if (motivations.length > 0) context.motivation = motivations.join(", ");

  if (/\b(commercial|business|warehouse|office|shop|facility|church|my company|our company)\b/i.test(allUserText)) {
    context.propertyType = "commercial";
  } else if (/\b(house|home|residential|roof)\b/i.test(allUserText)) {
    context.propertyType = "residential";
  }

  if (/\b(i own|we own|own my|own our|homeowner|my house|our house)\b/i.test(allUserText)) {
    context.homeowner = "owns";
  } else if (/\b(rent|renter|landlord|apartment|lease)\b/i.test(allUserText)) {
    context.homeowner = "rents";
  }

  const cityMatch = allUserText.match(/\b(?:in|near|around|out by)\s+(norman|oklahoma city|okc|edmond|moore|mustang|yukon|tulsa|broken arrow|stillwater|lawton|ardmore|shawnee|lake eufaula)\b/i);
  if (cityMatch) context.city = cityMatch[1].replace(/\bokc\b/i, "OKC");

  if (/\b(asap|soon|this week|today|tomorrow|ready|go ahead|let's do it|lets do it)\b/i.test(allUserText)) {
    context.urgency = "soon";
  }

  return context;
}

// --- iMessage via osascript ---

function sendIMessage(phone, text) {
  if (!ENABLE_IMESSAGE) {
    console.log("Skipping iMessage (ENABLE_IMESSAGE is false)");
    return;
  }

  if (os.platform() !== "darwin") {
    console.log("Skipping iMessage on non-macOS platform", os.platform());
    return;
  }

  const safeText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    'tell application "Messages"',
    "  set targetService to 1st account whose service type = iMessage",
    '  set targetBuddy to buddy "' + phone + '" of targetService',
    '  send "' + safeText + '" to targetBuddy',
    "end tell",
  ].join("\n");

  const tmpFile = path.join(
    os.tmpdir(),
    "imsg-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2) +
      ".scpt"
  );
  fs.writeFileSync(tmpFile, script);

  execFile("osascript", [tmpFile], { timeout: 30000 }, (err) => {
    if (err) {
      console.error(
        "iMessage send error to " + phone + ":",
        err.message.substring(0, 200)
      );
    } else {
      console.log("iMessage sent to " + phone);
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch (_) {}
  });
}

function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    message_thread_id: TELEGRAM_ALERTS_THREAD,
    text: message,
    parse_mode: "HTML",
  });
  fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
    .then((r) => r.json())
    .then((d) => console.log("Telegram alert sent, ok:", d.ok))
    .catch((e) => console.error("Telegram alert error:", e.message));
}

function sendNtfyAlert(message) {
  if (!NTFY_URL) return;
  fetch(NTFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Title: "Jennifer Chat Alert",
    },
    body: message,
  }).catch((e) => console.error("NTFY alert error:", e.message));
}

function sendPushoverAlert(title, message, options = {}) {
  if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) return;

  const body = new URLSearchParams({
    token: PUSHOVER_API_TOKEN,
    user: PUSHOVER_USER_KEY,
    title: title || "Jennifer Chat Alert",
    message: stripEmojis(String(message || "")).slice(0, 1024),
    priority: String(options.priority ?? 0),
    sound: options.sound || "pushover",
  });

  if (PUSHOVER_DEVICE) body.set("device", PUSHOVER_DEVICE);
  if (options.url) body.set("url", options.url);
  if (options.urlTitle) body.set("url_title", options.urlTitle);

  fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
    .then((r) => r.json())
    .then((d) => console.log("Pushover alert sent, status:", d.status))
    .catch((e) => console.error("Pushover alert error:", e.message));
}

function sendNewChatAlert(sessionId, userMessage, clientIp, userAgent) {
  if (!NEW_CHAT_ALERTS_ENABLED || !sessionId) return;

  const summary = String(userMessage || "").replace(/\s+/g, " ").trim().slice(0, 240);
  sendTelegramAlert(
    [
      "<b>New chat started</b>",
      "<b>Session:</b> " + sessionId,
      "<b>From:</b> " + (clientIp || "unknown"),
      "<b>UA:</b> " + (userAgent || "unknown"),
      "<b>First message:</b> " + (summary || "(empty)"),
    ].join("\n")
  );
  sendPushoverAlert(
    "New website chat",
    [
      "New chat started",
      "Session: " + sessionId,
      "From: " + (clientIp || "unknown"),
      "First message: " + (summary || "(empty)"),
    ].join("\n"),
    {
      priority: 0,
      sound: "pushover",
      url: historyUiUrl(),
      urlTitle: "Open chat history",
    }
  );

  if (!TELEGRAM_BOT_TOKEN) {
    sendNtfyAlert(stripEmojis(summary || "New chat started for " + sessionId));
  }
}

function formatLeadPhone(digits) {
  return "+1" + digits;
}

// --- Conversation summary via Ollama ---

function summarizeConversation(messages, callback) {
  if (!LEAD_SUMMARY_ENABLED) {
    callback(null);
    return;
  }

  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  const summaryPrompt = JSON.stringify({
    model: OLLAMA_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Summarize this solar lead conversation in 2-3 short sentences. Focus on what the customer said: their situation, concerns, and what they mentioned. Write it like a quick note to a salesperson about to call them. No greetings, no fluff. Start directly with what they said.",
      },
      { role: "user", content: userMessages },
    ],
    stream: false,
    temperature: 0.3,
    think: false,
    keep_alive: "5m",
  });

  const summaryReq = http.request(
    OLLAMA_HOST + "/api/chat",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    (summaryRes) => {
      let data = "";
      summaryRes.on("data", (chunk) => (data += chunk));
      summaryRes.on("end", () => {
        try {
          const result = JSON.parse(data);
          const summary = stripEmojis(result.message?.content || "");
          callback(summary || null);
        } catch (e) {
          console.error("Summary parse error:", e.message);
          callback(null);
        }
      });
    }
  );

  summaryReq.on("error", (e) => {
    console.error("Summary request error:", e.message);
    callback(null);
  });

  summaryReq.setTimeout(15000, () => {
    console.error("Summary request timed out");
    summaryReq.destroy();
    callback(null);
  });

  summaryReq.write(summaryPrompt);
  summaryReq.end();
}

// --- Lead capture ---

function checkAndSendLead(session, sessionId) {
  if (session.callbackAccepted === false) return;
  const existingLead = leadsBySession.get(sessionId);
  if (existingLead && existingLead.status === "completed") {
    session.leadSent = true;
    return;
  }
  if (session.leadSent && !existingLead) return;
  if (!session.leadData.phone) return;

  const context = extractContext(session.messages);
  const leadStatus = session.leadData.name && session.leadData.time ? "completed" : "partial";
  if (existingLead && existingLead.status === leadStatus) return;
  const leadScore = scoreLead(session.messages, context, session.leadData);
  const reasonRaw = extractReasonRaw(session.messages);
  session.leadSent = true;

  const leadPhone = formatLeadPhone(session.leadData.phone);
  const leadName = session.leadData.name || "unknown";

  const leadRecord = {
    sessionId,
    name: leadName,
    phone: leadPhone,
    time: session.leadData.time || null,
    status: leadStatus,
    score: leadScore.label,
    scorePoints: leadScore.points,
    intent: leadScore.intent,
    scoreReasons: leadScore.reasons,
    reasonRaw,
    utility: context.utility || null,
    bill: context.bill || null,
    motivation: context.motivation || null,
    propertyType: context.propertyType || null,
    homeowner: context.homeowner || null,
    city: context.city || null,
    urgency: context.urgency || null,
    createdAt: new Date().toISOString(),
    source: "jennifer-chat",
  };
  storeLeadRecord(leadRecord);

  console.log(JSON.stringify({
    event: "jennifer_lead_captured",
    sessionId,
    status: leadStatus,
    score: leadScore.label,
  }));

  // Build details + summary for Eric — send immediately so he's ready
  const details = [
    leadStatus === "completed" ? "New lead from chat:" : "Partial lead from chat:",
    "Name: " + leadName,
    "Phone: " + leadPhone,
    "Score: " + leadScore.label + " (" + leadScore.points + ")",
    "Intent: " + leadScore.intent,
  ];
  if (reasonRaw) details.push("Reason: " + reasonRaw);
  if (context.utility) details.push("Utility: " + context.utility);
  if (context.bill) details.push("Bill: " + context.bill);
  if (context.motivation) details.push("Why: " + context.motivation);
  if (context.propertyType) details.push("Property: " + context.propertyType);
  if (context.homeowner) details.push("Homeowner: " + context.homeowner);
  if (context.city) details.push("City: " + context.city);
  if (context.urgency) details.push("Urgency: " + context.urgency);
  if (session.leadData.time) details.push("Best time to call: " + session.leadData.time);

  sendPushoverAlert(
    leadScore.label + " " + (leadStatus === "completed" ? "Jennifer Lead" : "Jennifer Partial Lead"),
    details.join("\n"),
    {
      priority: leadScore.label === "HOT" ? 1 : 0,
      sound: leadScore.label === "HOT" ? "cashregister" : "pushover",
      url: historyUiUrl(),
      urlTitle: "Open chat history",
    }
  );

  summarizeConversation(session.messages, (summary) => {
    const lines = [
      "<b>" + leadScore.label + " " + (leadStatus === "completed" ? "Lead" : "Partial Lead") + "</b>",
      "<b>Name:</b> " + leadName,
      "<b>Phone:</b> " + leadPhone,
      "<b>Intent:</b> " + leadScore.intent,
      "<b>Score:</b> " + leadScore.points,
    ];
    if (leadScore.reasons.length) lines.push("<b>Why hot:</b> " + leadScore.reasons.join(", "));
    if (reasonRaw) lines.push("<b>Visitor reason:</b> " + reasonRaw);
    if (context.utility) lines.push("<b>Utility:</b> " + context.utility);
    if (context.bill) lines.push("<b>Bill:</b> " + context.bill);
    if (context.motivation) lines.push("<b>Why:</b> " + context.motivation);
    if (context.propertyType) lines.push("<b>Property:</b> " + context.propertyType);
    if (context.homeowner) lines.push("<b>Homeowner:</b> " + context.homeowner);
    if (context.city) lines.push("<b>City:</b> " + context.city);
    if (context.urgency) lines.push("<b>Urgency:</b> " + context.urgency);
    if (session.leadData.time) lines.push("<b>Best time:</b> " + session.leadData.time);
    if (summary) lines.push("\n" + summary);
    sendTelegramAlert(lines.join("\n"));
  });

  // Text the lead as Eric after a delay — feels human, not instant bot
  if (leadStatus === "completed") {
    session.leadTextTimer = setTimeout(() => {
      session.leadTextTimer = null;
      sendIMessage(
        leadPhone,
        "hey " + leadName + ", this is Eric with Affordable Solar. jennifer mentioned you had some questions about going solar. do you have a few minutes to chat?"
      );
    }, LEAD_TEXT_DELAY);
  }
}

function withdrawLead(sessionId) {
  const existingLead = leadsBySession.get(sessionId);
  if (!existingLead || existingLead.status === "withdrawn") return false;

  storeLeadRecord({
    ...existingLead,
    status: "withdrawn",
    withdrawnAt: new Date().toISOString(),
  });
  sendPushoverAlert(
    "Jennifer callback withdrawn",
    "Do not call. Callback consent was withdrawn.\nSession: " + sessionId,
    { priority: 1, sound: "pushover", url: historyUiUrl(), urlTitle: "Open chat history" }
  );
  sendTelegramAlert(
    "<b>Callback withdrawn</b>\nDo not call.\n<b>Session:</b> " + sessionId
  );
  console.log(JSON.stringify({
    event: "jennifer_lead_withdrawn",
    sessionId,
  }));
  return true;
}

async function requestOpenRouter(messages) {
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + OPENROUTER_API_KEY,
      "HTTP-Referer": "https://affordablesolar.io",
      "X-Title": "Jennifer Sales Chat",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) {
    console.error(JSON.stringify({
      event: "openrouter_bad_response",
      status: response.status,
      model: OPENROUTER_MODEL,
    }));
  }
  return {
    content: content || "Sorry, can you try asking again?",
    modelMs: Date.now() - startedAt,
  };
}

function logDecision(fields) {
  console.log(JSON.stringify({
    event: "jennifer_decision",
    ...fields,
    processUptimeMs: Math.round(process.uptime() * 1000),
  }));
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  console.log(new Date().toISOString(), req.method, pathname);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (
    req.method === "GET" &&
    (pathname === "/history-ui" || /^\/typebots\/[^/]+\/results$/.test(pathname))
  ) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHistoryUi(requestUrl.searchParams.get("token") || ""));
    return;
  }

  if (req.method === "GET" && pathname === "/history") {
    if (!isHistoryAuthorized(requestUrl.searchParams, res)) return;

    const sessionId = requestUrl.searchParams.get("sessionId");
    if (sessionId) {
      const messages = getHistoryPayload(sessionId);
      const session = sessions.get(sessionId);
      const context = extractContext(messages);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          messages,
          leadData: session ? session.leadData : {
            name: extractName(messages),
            phone: extractPhoneFromSession({ messages }),
            time: extractTime(messages),
            utility: context.utility || null,
            bill: context.bill || null,
          },
          count: messages.length,
          lastAccess: session ? session.lastAccess : null,
        })
      );
      return;
    }

    const sessionsSummary = [];
    for (const [id, messages] of historyBySession.entries()) {
      const lastMessage = messages[messages.length - 1] || null;
      sessionsSummary.push({
        sessionId: id,
        count: messages.length,
        lastMessage,
      });
    }
    sessionsSummary.sort((a, b) => {
      const aTime = new Date((a.lastMessage && a.lastMessage.at) || 0).getTime();
      const bTime = new Date((b.lastMessage && b.lastMessage.at) || 0).getTime();
      return bTime - aTime;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: sessionsSummary }));
    return;
  }

  if (req.method === "GET" && pathname === "/leads") {
    if (!isHistoryAuthorized(requestUrl.searchParams, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ leads: getLeadsPayload(), count: leadsBySession.size }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "Solar chat proxy running" }));
    return;
  }

  if (pathname === "/history/import") {
    if (!isHistoryAuthorized(requestUrl.searchParams, res)) return;

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        req.destroy(new Error("history import body too large"));
      }
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "[]");
        const records = Array.isArray(input) ? input : input.records;
        if (!Array.isArray(records)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "expected JSON array or { records: [...] }" }));
          return;
        }

        const result = importHistoryRecords(records);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "invalid import payload" }));
      }
    });
    req.on("error", (err) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "import request failed" }));
    });
    return;
  }

  if (pathname !== "/" && pathname !== "/chat") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (req.method === "POST") {
    const requestStartedAt = Date.now();
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const input = JSON.parse(body);
        const userMessage = input.message || "";
        const sessionId =
          (typeof input.sessionId === "string" && input.sessionId.trim()) ||
          `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        if (!userMessage) {
          logDecision({
            sessionId,
            intent: INTENTS.CURIOUS,
            stage: STAGES.OPEN,
            cleanupChanged: false,
            repeatDetected: false,
            retryCount: 0,
            modelMs: 0,
            totalMs: Date.now() - requestStartedAt,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response: "Hey! What can I help you with today?",
              sessionId,
            })
          );
          return;
        }

        const session = getSession(sessionId);
        const isNewChat = session && session.messages.length === 0 && !session.newChatNotified;

        if (isNewChat) {
          sendNewChatAlert(
            sessionId,
            userMessage,
            req.socket?.remoteAddress,
            req.headers["user-agent"]
          );
          session.newChatNotified = true;
        }

        if (session) {
          session.messages.push({ role: "user", content: userMessage });
          storeHistoryMessage(sessionId, "user", userMessage);
        }

        if (isIdentityQuestion(userMessage)) {
          const response = getIdentityResponse();
          if (session) {
            session.messages.push({ role: "assistant", content: response });
            storeHistoryMessage(sessionId, "assistant", response);
          }
          logDecision({
            sessionId,
            intent: INTENTS.CURIOUS,
            stage: STAGES.DISCOVER,
            cleanupChanged: false,
            repeatDetected: false,
            retryCount: 0,
            modelMs: 0,
            totalMs: Date.now() - requestStartedAt,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response, sessionId }));
          return;
        }

        // Quick intercept: if they want to call, give the number immediately
        if (isDirectCallRequest(userMessage)) {
          const response = getDirectCallResponse();
          if (session) {
            session.messages.push({ role: "assistant", content: response });
            storeHistoryMessage(sessionId, "assistant", response);
            checkAndSendLead(session, sessionId);
          }
          logDecision({
            sessionId,
            intent: INTENTS.DIRECT_CALL,
            stage: session?.stage || STAGES.OPEN,
            cleanupChanged: false,
            repeatDetected: false,
            retryCount: 0,
            modelMs: 0,
            totalMs: Date.now() - requestStartedAt,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response,
              sessionId,
            })
          );
          return;
        }

        // Determine stage AFTER adding the user message
        const activeStage = getActiveStage(session);
        if (isCallbackWithdrawal(userMessage)) withdrawLead(sessionId);
        const knownIntent = detectIntent(session ? session.messages : []);
        const knownParts = [];
        if (session?.callbackAccepted) knownParts.push("callback accepted");
        if (session?.leadData.name) knownParts.push("name: " + session.leadData.name);
        if (session?.leadData.phone) knownParts.push("phone number captured");
        if (session?.leadData.time) knownParts.push("preferred time: " + session.leadData.time);
        const contextNote = knownParts.length > 0
          ? "\n\nCONFIRMED CALLBACK DETAILS: " + knownParts.join(", ") + ". Do not ask for captured fields again."
          : "";
        const handoffNote = session?.callbackAccepted
          ? ""
          : "\n\nHANDOFF STATUS: The visitor has not requested or accepted human contact. Do not mention Eric, a callback, the office, a phone number, or contact collection. Continue helping with the latest topic.";

        // Build messages with stage instruction and known context appended
        const messages = [
          {
            role: "system",
            content: systemPrompt + "\n\n" + STAGE_INSTRUCTIONS[activeStage] + contextNote + handoffNote,
          },
        ];

        if (session) {
          for (const msg of session.messages) {
            messages.push(msg);
          }
        }

        (async () => {
          try {
            let retryCount = 0;
            let modelMs = 0;
            let repeatDetected = false;
            let retryStillRepeated = false;

            const firstAttempt = await requestOpenRouter(messages);
            modelMs += firstAttempt.modelMs;
            let response = postProcess(firstAttempt.content, activeStage, session);
            let cleanupChanged = response !== firstAttempt.content;
            const firstRepeated = isRepeatedReply(response, session ? session.messages : []);
            if (firstRepeated) {
              repeatDetected = true;
              const withoutRepeatedQuestion = removeRepeatedQuestions(
                response,
                session ? session.messages : []
              );
              if (withoutRepeatedQuestion !== response) {
                response = withoutRepeatedQuestion;
                cleanupChanged = true;
              }
            }

            if (needsModelRetry(response, session ? session.messages : [])) {
              repeatDetected = repeatDetected || isRepeatedReply(
                response,
                session ? session.messages : []
              );
              retryCount = 1;
              const retryMessages = messages.map((message, index) => index === 0
                ? {
                    ...message,
                    content: message.content +
                      "\n\nRETRY: The previous draft was empty after safety cleanup or repeated an earlier response or question. Answer the visitor's latest message directly, stay within the safety rules, and do not repeat any prior question.",
                  }
                : message);
              const retryAttempt = await requestOpenRouter(retryMessages);
              modelMs += retryAttempt.modelMs;
              let retryResponse = postProcess(retryAttempt.content, activeStage, session);
              const withoutRepeatedQuestion = removeRepeatedQuestions(
                retryResponse,
                session ? session.messages : []
              );
              cleanupChanged = cleanupChanged ||
                retryResponse !== retryAttempt.content ||
                withoutRepeatedQuestion !== retryResponse;
              retryResponse = withoutRepeatedQuestion;
              retryStillRepeated = needsModelRetry(retryResponse, session ? session.messages : []);
              response = retryStillRepeated
                ? getNonRepeatedRecovery(session ? session.messages : [])
                : retryResponse;
            }

            if (session) {
              session.messages.push({ role: "assistant", content: response });
              storeHistoryMessage(sessionId, "assistant", response);
              if (activeStage === STAGES.CONFIRM) {
                session.callbackConfirmed = true;
                session.stage = STAGES.DISCOVER;
              }
              checkAndSendLead(session, sessionId);
            }

            logDecision({
              sessionId,
              intent: knownIntent,
              stage: activeStage,
              cleanupChanged,
              repeatDetected,
              retryStillRepeated,
              retryCount,
              modelMs,
              totalMs: Date.now() - requestStartedAt,
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response, sessionId }));
          } catch (e) {
            console.error("OpenRouter fetch error:", e.message);
            logDecision({
              sessionId,
              intent: knownIntent,
              stage: activeStage,
              cleanupChanged: false,
              repeatDetected: false,
              retryCount: 0,
              modelMs: null,
              totalMs: Date.now() - requestStartedAt,
              error: true,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response: "Sorry, something went wrong. Call us at (405) 400-2836." }));
          }
        })();
      } catch (e) {
        console.error("Parse error:", e.message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ response: "Hey! Ask me anything about solar." })
        );
      }
    });
  }
});

function startServer() {
  loadHistoryFromDisk();
  loadLeadsFromDisk();
  startSessionCleanup();

  return server.listen(PORT, () => {
    console.log("Solar chat proxy listening on port " + PORT);
    console.log("Session TTL: " + SESSION_TTL / 1000 + "s");
    console.log("Lead notifications: iMessage to " + ERIC_PHONE);
    console.log("Stages: OPEN → DISCOVER → COLLECT_NAME → COLLECT_PHONE → CONFIRM");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  STAGES,
  INTENTS,
  detectIntent,
  extractContext,
  extractReasonRaw,
  extractName,
  extractTime,
  getActiveStage,
  getStage,
  getDirectCallResponse,
  getIdentityResponse,
  getNonRepeatedRecovery,
  isDirectCallRequest,
  isIdentityQuestion,
  isRepeatedReply,
  needsModelRetry,
  postProcess,
  removeRepeatedQuestions,
  startServer,
};
