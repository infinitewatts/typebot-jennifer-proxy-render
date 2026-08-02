"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const proxy = require("./jennifer-proxy");

const {
  STAGES,
  INTENTS,
  detectIntent,
  extractContext,
  extractReasonRaw,
  extractName,
  extractTime,
  inferSmsConsent,
  buildMessageIntent,
  messageIntentEventId,
  signMessageIntent,
  getActiveStage,
  postProcess,
  isDirectCallRequest,
  isIdentityQuestion,
  isRepeatedReply,
  getDirectCallResponse,
  getIdentityResponse,
  getNonRepeatedRecovery,
  needsModelRetry,
  removeRepeatedQuestions,
} = proxy;

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

function session(messages, stage = STAGES.OPEN, leadData = {}) {
  return {
    messages,
    stage,
    leadData: {
      name: null,
      phone: null,
      time: null,
      ...leadData,
    },
  };
}

const july18Question = "What is the cost to put solar in my house to make it off grid";
const july18Reason = "I don't want to rely on a power company with all the data centers here in oklahoma";
const forcedOutageReply = "that makes sense. how long were you without power the worst time?";
const rawBatteryQuestion = "what happened that made you start looking at batteries?";

test("July 18 cost plus off-grid question stays price-first", () => {
  const messages = [user(july18Question)];

  assert.equal(detectIntent(messages), INTENTS.PRICE);
});

test("latest recognized intent overrides older conversation intent", () => {
  const messages = [
    user("we had a two-day outage and need battery backup"),
    assistant("what do you need to keep running?"),
    user("how much does a solar system cost?"),
  ];

  assert.equal(detectIntent(messages), INTENTS.PRICE);
});

test("an unrecognized latest turn falls back to the earlier recognized intent", () => {
  const messages = [
    user("we had a two-day outage and need battery backup"),
    assistant("what do you need to keep running?"),
    user("okay that makes sense"),
  ];

  assert.equal(detectIntent(messages), INTENTS.BATTERY);
});

test("off-grid energy independence is distinct from an outage", () => {
  assert.equal(typeof INTENTS.OFF_GRID, "string");
  assert.equal(
    detectIntent([user("i want my home completely off grid")]),
    INTENTS.OFF_GRID
  );
  assert.equal(
    detectIntent([user("we lose power every storm and need battery backup")]),
    INTENTS.BATTERY
  );
  assert.equal(
    detectIntent([
      user(july18Question),
      assistant(forcedOutageReply),
      user(july18Reason),
    ]),
    INTENTS.OFF_GRID
  );
});

test("July 18 cost question is not stored as the visitor's reason", () => {
  const messages = [user(july18Question)];

  assert.equal(extractReasonRaw(messages), null);
  assert.match(extractContext(messages).motivation || "", /energy independence/);
});

test("the newest stated reason wins while surrounding questions are excluded", () => {
  const messages = [
    user(july18Question),
    assistant(forcedOutageReply),
    user(july18Reason),
    assistant("what would you want an off-grid system to cover?"),
    user("how much would that cost?"),
  ];

  assert.equal(extractReasonRaw(messages), july18Reason);
});

test("visitor questions are never stored as reasons", () => {
  for (const question of [
    july18Question,
    "what does solar cost?",
    "can i go off grid?",
    "are batteries worth it?",
  ]) {
    assert.equal(extractReasonRaw([user(question)]), null, question);
  }
});

test("July 18 first reply is not semantically rewritten into an outage assumption", () => {
  const currentSession = session([user(july18Question)], STAGES.DISCOVER);

  assert.equal(
    postProcess(rawBatteryQuestion, STAGES.DISCOVER, currentSession),
    rawBatteryQuestion
  );
});

test("July 18 second reply does not restore the exact prior outage sentence", () => {
  const currentSession = session(
    [
      user(july18Question),
      assistant(forcedOutageReply),
      user(july18Reason),
    ],
    STAGES.DISCOVER
  );

  const result = postProcess(rawBatteryQuestion, STAGES.DISCOVER, currentSession);

  assert.equal(result, rawBatteryQuestion);
  assert.notEqual(result, forcedOutageReply);
});

test("July 18 follow-up does not pivot to an unrequested callback", () => {
  const currentSession = session(
    [
      user(july18Question),
      assistant(
        "The cost depends on usage, roof, equipment, and backup needs."
      ),
      user(july18Reason),
    ],
    STAGES.DISCOVER
  );

  for (const draft of [
    "Energy independence is a valid reason to consider off-grid solar. Would you like a callback from Eric to discuss options?",
    "Energy independence is a valid reason to consider off-grid solar, would you like a callback from Eric to discuss options?",
    "Energy independence is a valid reason to consider off-grid solar; would you like to talk with Eric?",
    "Energy independence is a valid reason to consider off-grid solar.Would you like a callback from Eric?",
  ]) {
    assert.equal(
      postProcess(draft, STAGES.DISCOVER, currentSession),
      "Energy independence is a valid reason to consider off-grid solar.",
      draft
    );
  }
});

test("an accepted callback remains available after handoff consent", () => {
  const currentSession = session(
    [user("Please have Eric call me about an off-grid system")],
    STAGES.DISCOVER
  );
  assert.equal(getActiveStage(currentSession), STAGES.COLLECT_NAME);
  assert.equal(currentSession.callbackAccepted, true);

  const response = "I can arrange that callback. What is your name?";
  assert.equal(
    postProcess(response, STAGES.COLLECT_NAME, currentSession),
    response
  );
});

test("callback consent alone never becomes text consent", () => {
  assert.equal(
    inferSmsConsent([
      assistant("Would you like Eric to call you?"),
      user("yes, that works"),
    ]),
    null
  );
});

test("text consent requires an explicit affirmative answer to the text question", () => {
  const prompt = assistant("May Eric text this number about your solar questions? You can say no.");
  assert.deepEqual(
    inferSmsConsent([prompt, user("yes, that's fine")]),
    { accepted: true, text: "yes, that's fine", at: null }
  );
  assert.deepEqual(
    inferSmsConsent([prompt, user("no, do not text me")]),
    { accepted: false, text: "no, do not text me", at: null }
  );
});

test("completed callback details pause for text permission before confirmation", () => {
  const currentSession = session([], STAGES.COLLECT_TIME, {
    name: "Rachel Green",
    phone: "4055551234",
    time: "afternoons",
  });
  currentSession.callbackAccepted = true;
  currentSession.smsConsentAccepted = null;
  assert.equal(getActiveStage(currentSession), STAGES.COLLECT_SMS_CONSENT);

  currentSession.messages.push(
    assistant("May Eric text this number about your solar questions? You can say no."),
    user("yes")
  );
  assert.equal(getActiveStage(currentSession), STAGES.CONFIRM);
  assert.equal(currentSession.smsConsentAccepted, true);
  assert.equal(currentSession.smsConsentText, "yes");
});

test("message intents contain consent proof and a template id, never a remote body", () => {
  const lead = {
    status: "completed",
    sessionId: "session-123",
    phone: "+14055551234",
    name: "Rachel Green",
    smsConsentAccepted: true,
    smsConsentAt: "2026-08-02T18:00:00.000Z",
    smsConsentText: "yes, that's fine",
    messageIntentEventId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-02T18:00:01.000Z",
  };
  const intent = buildMessageIntent(lead);
  assert.equal(intent.template_id, "jennifer_initial_callback_v1");
  assert.equal(intent.sms_consent_version, "jennifer_sms_v1");
  assert.equal("body" in intent, false);
  assert.equal(buildMessageIntent({ ...lead, smsConsentAccepted: false }), null);

  const raw = JSON.stringify(intent);
  assert.equal(
    signMessageIntent("secret", "2026-08-02T18:00:02.000Z", raw),
    signMessageIntent("secret", "2026-08-02T18:00:02.000Z", raw)
  );
  assert.notEqual(
    signMessageIntent("secret", "2026-08-02T18:00:02.000Z", raw),
    signMessageIntent("other", "2026-08-02T18:00:02.000Z", raw)
  );

  const eventId = messageIntentEventId("session-123");
  assert.match(eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(eventId, messageIntentEventId("session-123"));
  assert.notEqual(eventId, messageIntentEventId("session-456"));
});

test("asking to call the office does not consent to a callback", () => {
  const currentSession = session(
    [user("Please call the office")],
    STAGES.DISCOVER
  );

  assert.equal(isDirectCallRequest("Please call the office"), true);
  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.callbackAccepted, false);
});

test("unrequested contact collection is removed without deleting the answer", () => {
  const currentSession = session(
    [user(july18Reason)],
    STAGES.DISCOVER
  );
  const answer = "Off-grid solar uses battery storage to run without grid power.";

  for (const draft of [
    answer + " What's your name?",
    answer + " What's the best number to reach you?",
    answer + " What time is best for Eric to call?",
    answer + " You can reach Eric at (405) 400-2836.",
  ]) {
    assert.equal(
      postProcess(draft, STAGES.DISCOVER, currentSession),
      answer,
      draft
    );
  }
});

test("detach/reset transcript does not turn Solar panels into a customer name", () => {
  const messages = [
    user("detach-and-reset tulsa ok 23 panels before roof replacement"),
    assistant("yeah, we do that. what got you looking into detach-and-reset specifically?"),
    user("Solar panels"),
  ];
  const currentSession = session(messages, STAGES.DISCOVER);

  assert.equal(extractName(messages), null);
  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.leadData.name, null);
});

test("ordinary short replies are not guessed as names", () => {
  const prompt = assistant("what got you looking into solar right now?");

  for (const reply of [
    "just curious",
    "my fridge",
    "solar panels",
    "battery backup",
    "not really",
    "maybe later",
  ]) {
    assert.equal(extractName([prompt, user(reply)]), null, reply);
  }
});

test("a name is still captured after an explicit name question", () => {
  assert.equal(
    extractName([
      assistant("what's your name?"),
      user("my name is Rachel Green"),
    ]),
    "Rachel Green"
  );
  assert.equal(
    extractName([assistant("what's your name?"), user("Josh")]),
    "Josh"
  );
});

test("explicit self-identification is captured without a prior name prompt", () => {
  assert.equal(extractName([user("my name is Josh")]), "Josh");
  assert.equal(extractName([user("call me Josh")]), "Josh");
  assert.equal(
    extractName([assistant("what's your name?"), user("i'm Josh")]),
    "Josh"
  );
});

test("ordinary first-person statements are not captured as names", () => {
  for (const statement of [
    "i'm off grid",
    "i'm Josh",
    "i'm confused",
    "i am worried",
    "i am in Tulsa",
    "i'm trying to lower my bill",
    "this is expensive",
    "call me tomorrow",
    "call me after lunch",
  ]) {
    assert.equal(extractName([user(statement)]), null, statement);
  }
});

test("first-person motivation statements remain available as reasons", () => {
  const statement = "I'm trying to be independent from the power company";

  assert.equal(extractReasonRaw([user(statement)]), statement);
});

test("questions, hesitation, and pauses are not guessed as callback times", () => {
  const prompt = assistant("what time's usually good to catch you?");

  for (const reply of [
    "what about batteries?",
    "not sure yet",
    "hold on a second",
    "i have another question",
  ]) {
    assert.equal(extractTime([prompt, user(reply)]), null, reply);
  }
});

test("a recognized time is still captured after an explicit time question", () => {
  assert.equal(
    extractTime([
      assistant("mornings or afternoons usually better for you?"),
      user("afternoons"),
    ]),
    "afternoons"
  );

  assert.equal(
    extractTime([
      assistant("what time's usually good to catch you?"),
      user("after lunch"),
    ]),
    "after lunch"
  );

  assert.equal(
    extractTime([
      assistant("what time's usually good to catch you?"),
      user("3 pm"),
    ]),
    "3 pm"
  );

  assert.equal(
    extractTime([
      assistant("what time of day is best to reach you?"),
      user("Tomorrow afternoon"),
    ]),
    "tomorrow afternoon"
  );
});

test("time extraction requires the immediately preceding assistant turn to ask for time", () => {
  assert.equal(extractTime([user("afternoons are easiest")]), null);
  assert.equal(
    extractTime([
      assistant("what time's usually good to catch you?"),
      user("hold on"),
      assistant("no rush"),
      user("afternoons"),
    ]),
    null
  );
  assert.equal(
    extractTime([
      assistant("good morning, what can i help with?"),
      user("night"),
    ]),
    null
  );
  assert.equal(
    extractTime([
      assistant("evening backup can be useful."),
      user("morning"),
    ]),
    null
  );
});

test("a side question does not complete a lead waiting for callback time", () => {
  const currentSession = session(
    [
      assistant("what time's usually good to catch you?"),
      user("what about batteries?"),
    ],
    STAGES.COLLECT_TIME,
    { name: "Rachel Green", phone: "4055551234" }
  );

  assert.equal(extractTime(currentSession.messages), null);
  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.leadData.time, null);
  assert.equal(currentSession.stage, STAGES.COLLECT_TIME);
});

test("explicit questions temporarily interrupt name, phone, and time collection", () => {
  const cases = [
    {
      stage: STAGES.COLLECT_NAME,
      leadData: {},
      messages: [
        assistant("Eric can look at your setup. what's your name?"),
        user("how much do batteries cost?"),
      ],
    },
    {
      stage: STAGES.COLLECT_PHONE,
      leadData: { name: "Rachel Green" },
      messages: [
        assistant("what's the best number to reach you at?"),
        user("what warranty do the batteries have?"),
      ],
    },
    {
      stage: STAGES.COLLECT_TIME,
      leadData: { name: "Rachel Green", phone: "4055551234" },
      messages: [
        assistant("what time's usually good to catch you?"),
        user("what about batteries?"),
      ],
    },
  ];

  for (const entry of cases) {
    const currentSession = session(entry.messages, entry.stage, entry.leadData);

    assert.equal(
      getActiveStage(currentSession),
      STAGES.DISCOVER,
      `stage ${entry.stage}`
    );
    assert.equal(currentSession.stage, entry.stage, `stored stage ${entry.stage}`);
  }
});

test("corrections interrupt collection without clearing stored callback state", () => {
  const currentSession = session(
    [
      assistant("Eric can look at your setup. what's your name?"),
      user("no, i meant the cost of batteries"),
    ],
    STAGES.COLLECT_NAME
  );

  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.stage, STAGES.COLLECT_NAME);
  assert.deepEqual(currentSession.leadData, { name: null, phone: null, time: null });
});

test("hesitation interrupts collection without clearing captured fields", () => {
  const currentSession = session(
    [
      assistant("what's the best number to reach you at?"),
      user("i'm not ready to share that yet"),
    ],
    STAGES.COLLECT_PHONE,
    { name: "Rachel Green" }
  );

  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.stage, STAGES.COLLECT_PHONE);
  assert.deepEqual(currentSession.leadData, {
    name: "Rachel Green",
    phone: null,
    time: null,
  });
});

test("callback withdrawal stops collection while preserving captured fields", () => {
  const currentSession = session(
    [
      assistant("what time's usually good to catch you?"),
      user("actually, don't call me"),
    ],
    STAGES.COLLECT_TIME,
    { name: "Rachel Green", phone: "4055551234" }
  );

  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.stage, STAGES.COLLECT_TIME);
  assert.deepEqual(currentSession.leadData, {
    name: "Rachel Green",
    phone: "4055551234",
    time: null,
  });

  currentSession.messages.push(
    assistant("understood, i won't arrange a call."),
    user("thanks")
  );
  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
});

test("callback collection begins only after explicit visitor acceptance", () => {
  const acceptedSession = session(
    [
      assistant("Would you like Eric to call you about that?"),
      user("yes, that works"),
    ],
    STAGES.DISCOVER
  );

  assert.equal(getActiveStage(acceptedSession), STAGES.COLLECT_NAME);
  assert.equal(acceptedSession.callbackAccepted, true);

  const acceptedConversation = session(
    [
      assistant("Would you like to speak with Eric about this?"),
      user("yes"),
    ],
    STAGES.DISCOVER
  );
  assert.equal(getActiveStage(acceptedConversation), STAGES.COLLECT_NAME);
  assert.equal(acceptedConversation.callbackAccepted, true);

  const unsolicitedDetails = session(
    [user("my name is Josh and the number on the old quote is 405-555-1212")],
    STAGES.DISCOVER
  );

  assert.equal(getActiveStage(unsolicitedDetails), STAGES.DISCOVER);
  assert.equal(unsolicitedDetails.callbackAccepted, false);
  assert.deepEqual(unsolicitedDetails.leadData, {
    name: null,
    phone: null,
    time: null,
  });

  const ericMentionOnly = session(
    [assistant("Eric handles battery questions."), user("yes")],
    STAGES.DISCOVER
  );
  assert.equal(getActiveStage(ericMentionOnly), STAGES.DISCOVER);
  assert.equal(ericMentionOnly.callbackAccepted, false);

  const selfIdentificationOnly = session(
    [user("call me Josh")],
    STAGES.DISCOVER
  );
  assert.equal(getActiveStage(selfIdentificationOnly), STAGES.DISCOVER);
  assert.equal(selfIdentificationOnly.callbackAccepted, false);
});

test("an explicit callback request captures an included phone number", () => {
  const currentSession = session(
    [user("please call me at 405-555-1212")],
    STAGES.DISCOVER
  );

  assert.equal(getActiveStage(currentSession), STAGES.COLLECT_NAME);
  assert.equal(currentSession.callbackAccepted, true);
  assert.equal(currentSession.leadData.phone, "4055551212");
});

test("a post-confirmation question remains answerable without losing lead fields", () => {
  const leadData = {
    name: "Rachel Green",
    phone: "4055551234",
    time: "afternoons",
  };
  const currentSession = session(
    [
      assistant("Eric will reach out this afternoon."),
      user("how do the batteries work?"),
    ],
    STAGES.CONFIRM,
    leadData
  );

  assert.equal(getActiveStage(currentSession), STAGES.DISCOVER);
  assert.equal(currentSession.stage, STAGES.CONFIRM);
  assert.deepEqual(currentSession.leadData, leadData);
});

test("AI identity questions do not trigger the human-call shortcut", () => {
  assert.equal(isIdentityQuestion("are you a real person or AI"), true);
  assert.equal(isIdentityQuestion("are you just a bot"), true);
  assert.equal(isDirectCallRequest("are you a real person or AI"), false);
  assert.equal(isDirectCallRequest("are you just a bot"), false);
  assert.equal(isDirectCallRequest("i do not want to talk to a real person"), false);
  assert.equal(isDirectCallRequest("can i talk to a real person"), true);
  assert.equal(typeof getIdentityResponse, "function");
  assert.match(getIdentityResponse(), /AI website assistant/i);
  assert.doesNotMatch(getIdentityResponse(), /405|what's your name|your name\?/i);
});

test("negated callback language is not a direct-call request", () => {
  for (const message of [
    "i don't want to call anyone",
    "do not call me",
    "i don't want to talk to a real person",
    "i don't want your phone number",
  ]) {
    assert.equal(isDirectCallRequest(message), false, message);
  }
});

test("the office-number shortcut does not start callback collection", () => {
  assert.equal(typeof getDirectCallResponse, "function");
  assert.match(getDirectCallResponse(), /\(405\) 400-2836/);
  assert.doesNotMatch(getDirectCallResponse(), /name|call you|reach out/i);
  assert.doesNotMatch(getDirectCallResponse(), /\?/);
});

test("safe model text passes through post-processing without topic replacement", () => {
  const raw = "battery sizing depends on the loads you want covered. what kind of backup are you considering?";
  const currentSession = session(
    [user("i want to learn about battery backup")],
    STAGES.DISCOVER
  );

  assert.equal(postProcess(raw, STAGES.DISCOVER, currentSession), raw);
});

test("identity safety cleanup cannot claim Jennifer is human", () => {
  const identitySession = session(
    [user("are you a real person or AI?")],
    STAGES.DISCOVER
  );
  const result = postProcess("I'm a real person.", STAGES.DISCOVER, identitySession);

  assert.match(result, /AI website assistant/i);
  assert.doesNotMatch(result, /i(?:'m| am) (?:a )?(?:real person|human)/i);
});

test("post-processing retains safety-only cleanup", () => {
  const currentSession = session([], STAGES.DISCOVER);
  const cleanups = [
    ["pricing varies by setup. 🙂", "pricing varies by setup."],
    [
      "hi, i'm Jennifer with Affordable Solar. pricing varies by setup.",
      "pricing varies by setup.",
    ],
    [
      "pricing depends on usage. what's your address?",
      "pricing depends on usage.",
    ],
    [
      "the federal tax credit can help. pricing depends on usage.",
      "pricing depends on usage.",
    ],
    [
      "i can send you a link to schedule a consultation. pricing depends on usage.",
      "pricing depends on usage.",
    ],
    [
      "you need a 24-panel system. pricing depends on usage.",
      "pricing depends on usage.",
    ],
    ["one. two. three. four.", "one. two. three."],
  ];

  for (const [raw, expected] of cleanups) {
    assert.equal(
      postProcess(raw, STAGES.DISCOVER, currentSession),
      expected,
      raw
    );
  }

  assert.equal(
    postProcess(
      "pricing varies. what is your bill? who is your utility?",
      STAGES.DISCOVER,
      currentSession
    ),
    "pricing varies. what is your bill?"
  );

  assert.equal(
    postProcess(
      "Oklahoma net metering uses a blended rate.",
      STAGES.DISCOVER,
      currentSession
    ),
    "Oklahoma net metering uses a blended rate."
  );

  assert.equal(
    postProcess(
      "Do you know your monthly electricity usage in kWh?",
      STAGES.DISCOVER,
      currentSession
    ),
    "Do you know your monthly electricity usage in kWh?"
  );

  const directCallSession = session(
    [user("Can I call the office?")],
    STAGES.DISCOVER
  );
  assert.equal(
    postProcess(
      "You can reach us at (405) 400-2836. Would you like me to connect you now?",
      STAGES.DISCOVER,
      directCallSession
    ),
    "You can reach us at (405) 400-2836."
  );
});

test("normalized repeated question clauses are detected", () => {
  const messages = [
    user("how much does solar cost?"),
    assistant("pricing depends on your setup. what's your bill running?"),
  ];

  assert.equal(
    isRepeatedReply(
      "i can help narrow that down. What's your bill running?",
      messages
    ),
    true
  );
});

test("a new answer survives when only its follow-up question was repeated", () => {
  const messages = [
    assistant("Would you like to talk with Eric about your options?"),
  ];
  const draft =
    "Financing with $0 down is available. Would you like to talk with Eric about your options?";

  assert.equal(typeof removeRepeatedQuestions, "function");
  assert.equal(
    removeRepeatedQuestions(draft, messages),
    "Financing with $0 down is available."
  );
  assert.equal(
    removeRepeatedQuestions(
      "Financing with $0 down is available, would you like to talk with Eric about your options?",
      messages
    ),
    "Financing with $0 down is available."
  );
});

test(
  "repeat detection survives reconstructed history without in-memory question tracking",
  { skip: typeof isRepeatedReply !== "function" },
  () => {
    const prior = "pricing depends on usage and equipment. what's your bill running?";
    const reconstructedSession = session(
      [user("how much does solar cost?"), assistant(prior)],
      STAGES.DISCOVER
    );

    assert.equal("askedQuestions" in reconstructedSession, false);
    assert.equal(isRepeatedReply(prior, reconstructedSession.messages), true);
  }
);

test("empty or repeated cleaned drafts trigger one model retry", () => {
  const prior = "pricing depends on usage. what's your bill running?";
  const messages = [user("how much does solar cost?"), assistant(prior)];

  assert.equal(typeof needsModelRetry, "function");
  assert.equal(needsModelRetry("", messages), true);
  assert.equal(needsModelRetry(prior, messages), true);
  assert.equal(needsModelRetry("pricing depends on your roof and usage.", messages), false);
});

test("repeat recovery is guaranteed not to duplicate prior assistant text", () => {
  const firstRecovery = "I didn't answer that well. Could you rephrase your latest question?";
  const messages = [
    assistant(firstRecovery),
    assistant("I lost the thread. What should I answer first?"),
  ];

  assert.equal(typeof getNonRepeatedRecovery, "function");
  const recovery = getNonRepeatedRecovery(messages);
  assert.equal(isRepeatedReply(recovery, messages), false);
});
