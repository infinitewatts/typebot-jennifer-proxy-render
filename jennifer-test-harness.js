const http = require("http");

const PROXY = "http://localhost:3090";

// Test scenarios - each is a sequence of user messages simulating different lead types
const scenarios = [
  {
    name: "HIGH_BILL_OGE",
    description: "Standard high-bill OG&E customer",
    messages: [
      "hey, looking into solar for my house",
      "my electric bill is killing me honestly",
      "OGE, paying about 280 a month",
      "yeah its been going up every year",
      "sure, my name is Rachel Green",
      "405-555-1234",
    ],
    expect: { shouldCaptureLead: true, shouldNotMention: ["tax credit", "ITC"] },
  },
  {
    name: "PRICE_FIRST",
    description: "Jumps straight to price - wants numbers immediately",
    messages: [
      "how much does solar cost",
      "for a house, about 2000 sq ft",
      "around 200 a month with PSO",
      "Mike Davis",
      "918-555-4321",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "SKEPTIC",
    description: "Skeptical, asking tough questions",
    messages: [
      "does solar actually save money or is it a scam",
      "i heard panels dont last and you lose money",
      "ok well how much would it actually cost me",
      "im with OGE paying like 180 a month",
      "i mean maybe, whats the catch",
    ],
    expect: { shouldNotMention: ["tax credit", "ITC"], shouldStayCalm: true },
  },
  {
    name: "ARE_YOU_AI",
    description: "Asks if Jennifer is AI",
    messages: [
      "are you a real person or AI",
      "ok cool. well im looking at solar options",
      "high bills mostly, paying 220 to OGE",
      "Sarah Kim",
      "405-555-9876",
    ],
    expect: { shouldAdmitAI: true, shouldCaptureLead: true },
  },
  {
    name: "BATTERY_FOCUSED",
    description: "Interested in battery backup, storm outages",
    messages: [
      "had two power outages last month, thinking about battery backup",
      "yeah we lost power for almost 2 days during the ice storm",
      "OGE, bill is usually around 200",
      "i want something that can run my fridge and heat at least",
      "Tom Bradley",
      "405-555-6789",
    ],
    expect: { shouldCaptureLead: true, shouldMentionBattery: true },
  },
  {
    name: "COMMERCIAL",
    description: "Commercial customer inquiry",
    messages: [
      "im looking at solar for my business",
      "its a warehouse, about 10000 sq ft, electric bill runs 2000 a month",
      "yeah with OGE, been thinking about it for a while",
      "James Morton",
      "405-555-3456",
    ],
    expect: { shouldCaptureLead: true, shouldNotPromisePayback: true },
  },
  {
    name: "JUST_CURIOUS",
    description: "Very casual, not committed, might leave",
    messages: [
      "just curious about solar",
      "not really sure tbh, just saw your website",
      "yeah i own my house, OGE, bills are maybe 150",
    ],
    expect: { shouldNotPush: true },
  },
  {
    name: "RAPID_FIRE",
    description: "User who gives info fast without being asked",
    messages: [
      "hey im Chris, 405-555-7777, OGE customer paying 300 a month, want a quote",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "OFF_GRID",
    description: "Wants to go completely off grid",
    messages: [
      "want to get completely off the grid",
      "im building a cabin out by lake eufaula, no power lines nearby",
      "probably AC, well pump, basic appliances",
      "yeah lets do it, name is Jake Reed",
      "918-555-2222",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "WANTS_TO_CALL",
    description: "Prefers to just call directly",
    messages: [
      "can I just call someone to talk about this",
    ],
    expect: { shouldGivePhoneNumber: true },
  },
  {
    name: "RENTER",
    description: "Doesn't own their home - should handle gracefully",
    messages: [
      "hey looking into solar",
      "yeah my bills are high, paying like 200 to OGE",
      "well actually I rent my place",
    ],
    expect: {},
  },
  {
    name: "PSO_CUSTOMER",
    description: "PSO customer in Tulsa area",
    messages: [
      "thinking about solar for my house in broken arrow",
      "yeah PSO bills are getting crazy, like 240 a month",
      "its mostly the summer AC that kills me",
      "Lisa Martinez",
      "918-555-3333",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "FINANCING_QUESTIONS",
    description: "Wants to know about payment plans and financing",
    messages: [
      "how much is it to go solar",
      "i dont have 20 or 30 thousand dollars laying around",
      "what kind of financing do you offer",
      "ok that sounds reasonable, OGE customer paying 190 a month",
      "Steve Park",
      "405-555-8888",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "HAIL_WORRIED",
    description: "Worried about Oklahoma hail and storms",
    messages: [
      "interested in solar but worried about hail damage",
      "we had golf ball size hail last spring",
      "so insurance covers it?",
      "ok good, im with OGE paying about 210",
      "Mark Stevens",
      "405-555-4444",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "NEIGHBOR_REFERRAL",
    description: "Saw neighbor got solar installed",
    messages: [
      "my neighbor just got solar panels and said I should check you guys out",
      "yeah he said his bill went way down",
      "were with OGE, bill is about 175",
      "Amy Chen",
      "405-555-6666",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "SHORT_RESPONSES",
    description: "Gives very brief one-word answers",
    messages: [
      "solar",
      "bills",
      "OGE",
      "200",
      "yeah",
      "Dan",
      "4055551111",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "NEW_CONSTRUCTION",
    description: "Building a new home, wants solar from the start",
    messages: [
      "building a new house and want to include solar from the start",
      "its going to be about 2500 sq ft in edmond",
      "yeah we want to do it right the first time",
      "Katie Wells",
      "405-555-2222",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "HOSTILE_DISMISSIVE",
    description: "Rude or dismissive, testing how Jennifer handles it",
    messages: [
      "solar is a waste of money",
      "you people just want to rip people off",
      "whatever",
    ],
    expect: {},
  },
  {
    name: "EV_CHARGER",
    description: "Wants EV charger plus solar",
    messages: [
      "just got a tesla and want to charge it with solar",
      "yeah my electric bill jumped like 80 bucks since I got the car",
      "OGE, total bill is around 260 now",
      "Brian Taylor",
      "405-555-7777",
    ],
    expect: { shouldCaptureLead: true },
  },
  {
    name: "ALREADY_HAS_QUOTES",
    description: "Shopping around, already talked to other companies",
    messages: [
      "ive gotten a couple quotes from other solar companies already",
      "yeah but the prices seem all over the place",
      "one said 22k another said 28k for basically the same thing",
      "OGE, paying about 230 a month",
      "Rob Miller",
      "405-555-9999",
    ],
    expect: { shouldCaptureLead: true },
  },
];

function chat(sessionId, message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ message, sessionId });
    const req = http.request(
      PROXY + "/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            resolve(result.response || "");
          } catch (e) {
            reject(new Error("Parse error: " + e.message));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(60000);
    req.write(payload);
    req.end();
  });
}

function evaluate(scenario, responses) {
  const issues = [];
  const allText = responses.join(" ").toLowerCase();

  // Check for markdown/formatting violations
  if (/\*\*|##|^\s*-\s/m.test(responses.join("\n"))) {
    issues.push("FORMATTING: Used markdown (bold, headers, or bullet points)");
  }

  // Check for emoji
  if (/[\u{1F600}-\u{1FAFF}]/u.test(responses.join(" "))) {
    issues.push("FORMATTING: Used emojis");
  }

  // Check for banned words
  const banned = ["robust", "transformative", "utilize", "synergy", "leverage", "optimize", "streamline"];
  for (const word of banned) {
    if (allText.includes(word)) {
      issues.push("BANNED_WORD: Used '" + word + "'");
    }
  }

  // Check for stacked questions (multiple ? in one response)
  for (let i = 0; i < responses.length; i++) {
    const qCount = (responses[i].match(/\?/g) || []).length;
    if (qCount > 1) {
      issues.push("STACKED_QUESTIONS: Response " + (i + 1) + " has " + qCount + " questions");
    }
  }

  // Check response length (should be short)
  for (let i = 0; i < responses.length; i++) {
    const sentences = responses[i].split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 4) {
      issues.push("TOO_LONG: Response " + (i + 1) + " has " + sentences.length + " sentences");
    }
  }

  // Check for ITC/tax credit mentions
  if (scenario.expect.shouldNotMention) {
    for (const term of scenario.expect.shouldNotMention) {
      if (allText.includes(term.toLowerCase())) {
        issues.push("FORBIDDEN_TOPIC: Mentioned '" + term + "'");
      }
    }
  }

  // Check AI honesty
  if (scenario.expect.shouldAdmitAI) {
    const firstResponse = responses[0].toLowerCase();
    if (firstResponse.includes("i'm real") || firstResponse.includes("not a bot") || firstResponse.includes("nope")) {
      issues.push("AI_HONESTY: Denied being AI");
    }
  }

  // Check phone number given when requested
  if (scenario.expect.shouldGivePhoneNumber) {
    if (!allText.includes("405") || !allText.includes("2836")) {
      issues.push("PHONE_NUMBER: Didn't give (405) 400-2836 when user wanted to call");
    }
  }

  // Check for scheduling questions (mornings/afternoons, this week/next week)
  if (/morning|afternoon|evening|this week|next week|what time|when.*available/i.test(allText)) {
    issues.push("SCHEDULING: Asked about scheduling/availability (should not)");
  }

  // Check for email asks
  if (/email|e-mail/i.test(allText) && /what.*email|your email|email address/i.test(allText)) {
    issues.push("EMAIL: Asked for email address");
  }

  // Check for URL/link mentions
  if (/https?:\/\/|\.com|\.io|affordablesolar\./i.test(allText)) {
    issues.push("URL: Mentioned a URL or website");
  }

  // Check for address/zip asks
  if (/your address|your zip|zip code|share your address/i.test(allText)) {
    issues.push("ADDRESS: Asked for address or zip code (should only collect name + phone)");
  }

  // Check for link/form mentions
  if (/send you a link|text you a link|quote form|schedule a|consultation link/i.test(allText)) {
    issues.push("LINK_MENTION: Mentioned sending a link or form (doesn't exist)");
  }

  // Check for kWh calculations
  if (/kwh|kilowatt.hour/i.test(allText)) {
    issues.push("TECHNICAL: Used kWh/kilowatt-hour calculations (too technical)");
  }

  return issues;
}

async function runScenario(scenario, index) {
  const sessionId = "test-v2-" + index + "-" + Date.now();
  const responses = [];

  console.log("\n" + "=".repeat(60));
  console.log("SCENARIO: " + scenario.name);
  console.log("Description: " + scenario.description);
  console.log("=".repeat(60));

  for (let i = 0; i < scenario.messages.length; i++) {
    const msg = scenario.messages[i];
    console.log("\n  USER: " + msg);

    try {
      const response = await chat(sessionId, msg);
      responses.push(response);
      console.log("  JENNIFER: " + response);
    } catch (e) {
      console.log("  ERROR: " + e.message);
      responses.push("[ERROR]");
    }

    // Small delay between messages
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Evaluate
  const issues = evaluate(scenario, responses);

  console.log("\n  --- EVALUATION ---");
  if (issues.length === 0) {
    console.log("  PASS - No issues detected");
  } else {
    for (const issue of issues) {
      console.log("  FAIL - " + issue);
    }
  }

  return { name: scenario.name, issues, responses };
}

async function main() {
  console.log("Jennifer v2 System Prompt Test Harness");
  console.log("Running " + scenarios.length + " scenarios against local Ollama...");
  console.log("Model: qwen3:8b | Proxy: " + PROXY);

  const results = [];

  for (let i = 0; i < scenarios.length; i++) {
    const result = await runScenario(scenarios[i], i);
    results.push(result);
  }

  // Summary
  console.log("\n\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.issues.length === 0 ? "PASS" : "FAIL (" + result.issues.length + " issues)";
    console.log("  " + result.name + ": " + status);
    if (result.issues.length === 0) passed++;
    else failed++;
  }

  console.log("\n  Total: " + passed + "/" + results.length + " passed, " + failed + " failed");
  console.log("=".repeat(60));
}

main().catch(console.error);
