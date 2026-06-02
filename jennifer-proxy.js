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
const LEAD_SUMMARY_ENABLED = !/^(0|false|off|no)$/i.test((process.env.LEAD_SUMMARY_ENABLED || "true").trim());
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || "qwen3:8b").trim();
const ENABLE_IMESSAGE = /^\s*(1|true|yes|on)\s*$/i.test((process.env.ENABLE_IMESSAGE || "false").trim());
const CHAT_HISTORY_FILE = path.resolve(
  process.env.JENNIFER_CHAT_HISTORY_FILE ||
    path.join(__dirname, "chat-history.jsonl")
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

// --- Stage definitions (forward-only) ---

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
    "STAGE: OPEN. The website widget already showed Jennifer's intro before this chat started. Do NOT introduce yourself again or repeat your name. If their message is just a greeting, reply with one short line like 'what can i help you with today?' If they already asked a question or told you why they're here, answer that directly and move forward. One question only.",
  [STAGES.DISCOVER]:
    "STAGE: DISCOVER. Answer any question they asked using your knowledge, briefly. For pricing questions, say pricing varies based on their energy needs, roof, and equipment. Do NOT say 'we don't quote prices online' and do NOT kick them to Eric immediately. Then ask the one discovery question most relevant to their situation, usually electric company or bill. Don't repeat what they told you. Don't stack questions.",
  [STAGES.COLLECT_NAME]:
    "STAGE: COLLECT NAME. You have enough to make the handoff. Use one of your PIVOT TO CALL lines from the system prompt, riffed naturally. The frame is: Eric can answer all their questions better than you can in a quick call. Ask for their name. Do not say 'get a quote.' Do not ask anything else.",
  [STAGES.COLLECT_PHONE]:
    "STAGE: COLLECT PHONE. You have their name. Ask for the best number to reach them. One sentence only. Do not ask anything else.",
  [STAGES.COLLECT_TIME]:
    "STAGE: COLLECT TIME. You have their name and phone. Ask what time of day usually works best for them to get a call. Keep it casual, one short question: 'mornings or afternoons usually better for you?' or 'what time's usually good to catch you?' Do not ask anything else.",
  [STAGES.CONFIRM]:
    "STAGE: DONE. You have their name, phone, and preferred time. Wrap it up. Tell them Eric will reach out at that time and he'll have everything he needs, they won't have to start from scratch. Do NOT ask any questions. End with a period.",
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

function isHistoryAuthorized(queryParams, res) {
  if (!CHAT_HISTORY_ACCESS_TOKEN) return true;
  const token = queryParams.get("token") || "";
  if (token === CHAT_HISTORY_ACCESS_TOKEN) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
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

function storeHistoryMessage(sessionId, role, content) {
  if (!CHAT_HISTORY_ENABLED || !sessionId) return;

  const messages = historyBySession.get(sessionId) || [];
  const at = new Date().toISOString();
  messages.push({ role, content, at });
  historyBySession.set(sessionId, trimHistory(messages));

  const record = JSON.stringify({ sessionId, role, content, at }) + "\n";
  fs.appendFile(CHAT_HISTORY_FILE, record, (err) => {
    if (err) {
      console.error("History write error:", err.message);
    }
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
      if (!response.ok) throw new Error(text || response.statusText);
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

function getStage(session) {
  const context = extractContext(session.messages);
  const name = extractName(session.messages);
  const phone = extractPhoneFromSession(session);

  if (name) session.leadData.name = name;
  if (phone) session.leadData.phone = phone;

  const time = extractTime(session.messages);
  if (time) session.leadData.time = time;

  if (session.leadData.name && session.leadData.phone && session.leadData.time) return STAGES.CONFIRM;
  if (session.leadData.name && session.leadData.phone && !session.leadData.time) return STAGES.COLLECT_TIME;
  if (session.leadData.name && !session.leadData.phone) return STAGES.COLLECT_PHONE;

  // Count how many data points we have
  let dataPoints = 0;
  if (context.utility) dataPoints++;
  if (context.bill) dataPoints++;
  if (context.motivation) dataPoints++;

  const userMessages = session.messages.filter((m) => m.role === "user");
  const userMsgCount = userMessages.length;
  const firstUserMsg = userMessages[0]?.content || "";
  const lastUserMsg = userMessages[userMsgCount - 1];
  const assistantMessages = session.messages.filter((m) => m.role === "assistant");
  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];

  // Buying signal: user gives a short affirmation after Jennifer offers to get a quote/plan/advisor
  if (
    dataPoints >= 1 &&
    session.messages.length >= 4 &&
    lastUserMsg &&
    lastAssistantMsg &&
    /^(?:ok|okay|sure|sounds good|go ahead|great|alright|yeah|yes|yep|perfect)\.?$/i.test(lastUserMsg.content.trim()) &&
    /(?:quote|setup|plan|advisor|reach out|look into|call you|set.*up)/i.test(lastAssistantMsg.content)
  ) {
    return STAGES.COLLECT_NAME;
  }

  // Need at least 4 user messages AND 2+ data points before pivoting to name collection
  // This ensures enough back-and-forth discovery before asking for contact info
  if (dataPoints >= 2 && userMsgCount >= 4) return STAGES.COLLECT_NAME;

  // Hard fallback: long conversation with any signal, stop discovering
  if (userMsgCount >= 8 && dataPoints >= 1) return STAGES.COLLECT_NAME;
  if (userMsgCount >= 11) return STAGES.COLLECT_NAME;

  if (userMsgCount === 1) {
    if (isGenericGreeting(firstUserMsg)) return STAGES.OPEN;
    return STAGES.DISCOVER;
  }

  // If we have any conversation history beyond the first exchange, we're discovering
  if (session.messages.length >= 2) return STAGES.DISCOVER;

  return STAGES.OPEN;
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
  const newSession = {
    messages: initialMessages,
    lastAccess: Date.now(),
    leadSent: shouldReuseHistory
      ? Boolean(extractName(storedMessages) && extractPhoneFromSession({ messages: storedMessages }) && extractTime(storedMessages))
      : false,
    leadData: shouldReuseHistory
      ? {
          name: extractName(storedMessages),
          phone: extractPhoneFromSession({ messages: storedMessages }),
          time: extractTime(storedMessages),
        }
      : { name: null, phone: null, time: null },
    stage: STAGES.OPEN,
    newChatNotified: false,
    startedAt: Date.now(),
    sessionId,
  };
  sessions.set(sessionId, newSession);
  return newSession;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL) {
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

// --- Post-processing ---

function stripEmojis(text) {
  return text
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

function postProcess(text, stage, session) {
  let result = stripEmojis(text);

  // Repeat guard: if this response is too similar to the last one, force a redirect
  if (session && session.messages.length >= 2) {
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      const similarity = lastAssistant.content.toLowerCase().trim();
      const current = result.toLowerCase().trim();
      if (similarity === current || current.includes(similarity.slice(0, Math.min(similarity.length, 40)))) {
        // Response is a repeat. Replace with a stage-appropriate redirect.
        if (stage === STAGES.COLLECT_NAME) {
          result = "let me have one of our energy advisors look into this for you. what's your name?";
        } else if (stage === STAGES.COLLECT_PHONE) {
          result = "what's the best number to reach you at?";
        } else if (stage === STAGES.DISCOVER) {
          result = "so I can get you the right info, what's your monthly electric bill roughly?";
        } else {
          result = "tell me a bit more about what you're looking for.";
        }
      }
    }
  }

  // Strip em dashes
  result = result.replace(/\u2014/g, ",").replace(/--/g, ",");

  // Strip address/zip asks from any stage
  result = result.replace(/[^.!?]*\b(?:your address|your zip|zip code|share your address|what's your address)\b[^.!?]*[.!?]?/gi, "").trim();

  // Strip link/form/online-scheduling mentions (but NOT casual time preference questions)
  result = result.replace(/[^.!?]*\b(?:send you a link|text you a link|quote form|schedule (?:a )?(?:consultation|visit|appointment)|sign up for|fill out|online calendar|booking link)\b[^.!?]*[.!?]?/gi, "").trim();

  // Strip ITC/tax credit mentions
  result = result.replace(/[^.!?]*\b(?:ITC|tax credit|federal incentive|federal tax|investment tax)\b[^.!?]*[.!?]?/gi, "").trim();

  // Strip technical jargon
  result = result.replace(/\bkwh\b/gi, "power").replace(/\bkilowatt.hours?\b/gi, "power");

  // CONFIRM stage: no questions allowed
  if (stage === STAGES.CONFIRM) {
    // Replace trailing question with period
    result = result.replace(/\?/g, ".");
    // Clean up double periods
    result = result.replace(/\.{2,}/g, ".");
  }

  // All other stages: enforce max one question mark
  if (stage !== STAGES.CONFIRM) {
    const qMarks = (result.match(/\?/g) || []).length;
    if (qMarks > 1) {
      // Keep everything up to and including the first question mark
      const firstQ = result.indexOf("?");
      result = result.substring(0, firstQ + 1);
    }
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
  if (/\d/.test(text)) return false;
  if (text.split(/\s+/).length > 4) return false;
  if (
    /\b(i have|i got|i use|oge|og&e|pso|co-op|around|about|yes|no|yeah|nah|sure|ok)\b/i.test(
      text
    )
  )
    return false;
  if (!/^[a-zA-Z\s.\-']+$/.test(text)) return false;
  return true;
}

function extractName(messages) {
  // First pass: response right after Jennifer asks for name
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (
      prev.role === "assistant" &&
      curr.role === "user" &&
      /(?:what's your name|your name\??$|who am i talking|what's your first name)/i.test(
        prev.content
      )
    ) {
      const response = curr.content.trim();
      const cleaned = response
        .replace(
          /^(?:my name is|i'm|it's|this is|i am|hey i'm|hey it's|call me)\s+/i,
          ""
        )
        .replace(/[.!,]+$/, "")
        .trim();
      if (
        cleaned.length > 0 &&
        cleaned.length < 40 &&
        looksLikeName(cleaned)
      ) {
        return cleaned
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
      }
    }
  }

  // Second pass: response after combined name+number ask
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (
      prev.role === "assistant" &&
      curr.role === "user" &&
      /(?:grab your (?:name|info)|get your (?:name|info)|name and number|can you share your name|what's your name)/i.test(
        prev.content
      )
    ) {
      const response = curr.content.trim();
      const cleaned = response
        .replace(
          /^(?:my name is|i'm|it's|this is|i am|hey i'm|hey it's|call me)\s+/i,
          ""
        )
        .replace(/[.!,]+$/, "")
        .trim();
      if (
        cleaned.length > 0 &&
        cleaned.length < 40 &&
        looksLikeName(cleaned)
      ) {
        return cleaned
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
      }
    }
  }

  // Third pass: Jennifer uses the name in her response
  for (let i = 2; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const nameMatch = msg.content.match(
        /(?:perfect|great|awesome|thanks|nice|got it),?\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)\s*[!.]/i
      );
      if (nameMatch && looksLikeName(nameMatch[1])) {
        return nameMatch[1];
      }
    }
  }

  // Fourth pass: user message that looks like just a name (short, no numbers, follows an ask)
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev.role === "assistant" && curr.role === "user") {
      const text = curr.content.trim();
      const cleaned = text
        .replace(
          /^(?:my name is|i'm|it's|this is|i am|hey i'm|hey it's|call me)\s+/i,
          ""
        )
        .replace(/[.!,]+$/, "")
        .trim();
      if (
        cleaned.length > 1 &&
        cleaned.length < 30 &&
        cleaned.split(/\s+/).length <= 3 &&
        looksLikeName(cleaned) &&
        !extractPhone(text)
      ) {
        return cleaned
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
      }
    }
  }

  return null;
}

function extractTime(messages) {
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (
      prev.role === "assistant" &&
      curr.role === "user" &&
      /morning|afternoon|evening|what time|time.*good|catch you/i.test(prev.content)
    ) {
      const text = curr.content.trim().toLowerCase();
      if (/\d{3}[\s.\-]\d{3,4}/.test(text)) continue; // looks like a phone number, skip
      if (/morning/i.test(text)) return "mornings";
      if (/afternoon/i.test(text)) return "afternoons";
      if (/evening|night/i.test(text)) return "evenings";
      if (/anytime|any time|whenever|doesn.t matter|don.t care/i.test(text)) return "anytime";
      if (/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(text)) {
        const match = text.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i);
        return match ? match[0] : text.substring(0, 30);
      }
      if (text.length > 0 && text.length < 40) return text;
    }
  }
  return null;
}

function extractContext(messages) {
  const context = { utility: null, bill: null, motivation: null };
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
  if (session.leadSent) return;
  if (!session.leadData.name || !session.leadData.phone || !session.leadData.time) return;

  const context = extractContext(session.messages);
  session.leadSent = true;

  const leadPhone = formatLeadPhone(session.leadData.phone);
  const leadName = session.leadData.name;

  console.log("=== LEAD CAPTURED ===");
  console.log(
    JSON.stringify(
      {
        name: leadName,
        phone: leadPhone,
        time: session.leadData.time,
        utility: context.utility,
        bill: context.bill,
        motivation: context.motivation,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("=====================");

  // Build details + summary for Eric — send immediately so he's ready
  const details = [
    "New lead from chat:",
    "Name: " + leadName,
    "Phone: " + leadPhone,
  ];
  if (context.utility) details.push("Utility: " + context.utility);
  if (context.bill) details.push("Bill: " + context.bill);
  if (context.motivation) details.push("Why: " + context.motivation);
  if (session.leadData.time) details.push("Best time to call: " + session.leadData.time);

  summarizeConversation(session.messages, (summary) => {
    const lines = [
      "<b>New Lead</b>",
      "<b>Name:</b> " + leadName,
      "<b>Phone:</b> " + leadPhone,
    ];
    if (context.utility) lines.push("<b>Utility:</b> " + context.utility);
    if (context.bill) lines.push("<b>Bill:</b> " + context.bill);
    if (context.motivation) lines.push("<b>Why:</b> " + context.motivation);
    if (session.leadData.time) lines.push("<b>Best time:</b> " + session.leadData.time);
    if (summary) lines.push("\n" + summary);
    sendTelegramAlert(lines.join("\n"));
  });

  // Text the lead as Eric after a delay — feels human, not instant bot
  setTimeout(() => {
    sendIMessage(
      leadPhone,
      "hey " + leadName + ", this is Eric with Affordable Solar. jennifer mentioned you had some questions about going solar. do you have a few minutes to chat?"
    );
  }, LEAD_TEXT_DELAY);
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  console.log(new Date().toISOString(), req.method, req.url);
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

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
    if (!isHistoryAuthorized(requestUrl.searchParams, res)) return;
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

  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "Solar chat proxy running" }));
    return;
  }

  if (pathname !== "/" && pathname !== "/chat") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      console.log("Request body:", body.substring(0, 200));

      try {
        const input = JSON.parse(body);
        const userMessage = input.message || "";
        const sessionId =
          (typeof input.sessionId === "string" && input.sessionId.trim()) ||
          `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        if (!userMessage) {
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

        // Quick intercept: if they want to call, give the number immediately
        if (/\b(can i call|just call|rather call|want to call|phone number|talk to someone|speak to someone|talk to a person|real person)\b/i.test(userMessage)) {
          const response = "for sure — give us a call at (405) 400-2836 anytime. our team is here to help.";
          if (session) {
            session.messages.push({ role: "assistant", content: response });
            storeHistoryMessage(sessionId, "assistant", response);
          }
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
        const stage = session ? getStage(session) : STAGES.OPEN;
        const stageInstruction = STAGE_INSTRUCTIONS[stage];

        // Stage can only go forward
        if (stage > (session.stage || STAGES.OPEN)) {
          session.stage = stage;
        }
        const activeStage = session.stage || stage;

        console.log(
          "Session " +
            (sessionId || "none") +
            ": stage=" +
            activeStage +
            " messages=" +
            (session ? session.messages.length : 0)
        );

        // Build context summary so Jennifer doesn't re-ask what she already knows
        const knownContext = extractContext(session ? session.messages : []);
        const knownParts = [];
        if (knownContext.utility) knownParts.push("utility: " + knownContext.utility);
        if (knownContext.bill) knownParts.push("bill: " + knownContext.bill);
        if (knownContext.motivation) knownParts.push("motivation: " + knownContext.motivation);
        const contextNote = knownParts.length > 0
          ? "\n\nWHAT YOU KNOW SO FAR: " + knownParts.join(", ") + ". Do NOT ask about these again."
          : "";

        // Build messages with stage instruction and known context appended
        const messages = [
          {
            role: "system",
            content: systemPrompt + "\n\n" + STAGE_INSTRUCTIONS[activeStage] + contextNote,
          },
        ];

        if (session) {
          for (const msg of session.messages) {
            messages.push(msg);
          }
        }

        (async () => {
          try {
            const chatResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + OPENROUTER_API_KEY,
                "HTTP-Referer": "https://affordablesolar.io",
                "X-Title": "Jennifer Sales Chat",
              },
              body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: messages,
                temperature: 0.7,
                max_tokens: 200,
              }),
              signal: AbortSignal.timeout(30000),
            });

            const result = await chatResp.json();

            if (!result.choices?.[0]?.message?.content) {
              console.error("OpenRouter bad response:", JSON.stringify(result).substring(0, 300));
            }

            let response =
              result.choices?.[0]?.message?.content ||
              "Sorry, can you try asking again?";

            response = postProcess(response, activeStage, session);

            console.log("OpenRouter response (stage " + activeStage + "):", response.substring(0, 100));

            if (session) {
              session.messages.push({ role: "assistant", content: response });
              storeHistoryMessage(sessionId, "assistant", response);
              checkAndSendLead(session, sessionId);
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response, sessionId }));
          } catch (e) {
            console.error("OpenRouter fetch error:", e.message);
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

loadHistoryFromDisk();

server.listen(PORT, () => {
  console.log("Solar chat proxy listening on port " + PORT);
  console.log("Session TTL: " + SESSION_TTL / 1000 + "s");
  console.log("Lead notifications: iMessage to " + ERIC_PHONE);
  console.log("Stages: OPEN → DISCOVER → COLLECT_NAME → COLLECT_PHONE → CONFIRM");
});
