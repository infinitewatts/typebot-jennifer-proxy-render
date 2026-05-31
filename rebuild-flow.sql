-- Update variables
UPDATE "PublicTypebot"
SET "variables" = '[
  {"id": "var_user_msg", "name": "user_message", "isSessionVariable": false},
  {"id": "var_llm_response", "name": "llm_response", "isSessionVariable": false},
  {"id": "var_name", "name": "customer_name", "isSessionVariable": false},
  {"id": "var_phone", "name": "phone", "isSessionVariable": false},
  {"id": "var_email", "name": "email", "isSessionVariable": false},
  {"id": "var_chat_history", "name": "chat_history", "isSessionVariable": false}
]'::jsonb
WHERE "id" = 'cmmy41w3m0002my1z919waitb';

-- Build the complete flow with proper escaping
UPDATE "PublicTypebot"
SET "groups" = '[
  {
    "id": "grp_welcome",
    "title": "Welcome",
    "blocks": [
      {
        "id": "blk_welcome_msg",
        "type": "text",
        "content": {
          "richText": [
            {
              "type": "p",
              "children": [
                {"text": "hello, I\u0027m Jennifer with Affordable Solar. what brings you to us today?"}
              ]
            }
          ]
        }
      },
      {
        "id": "blk_welcome_input",
        "type": "text input",
        "options": {
          "isLong": false,
          "labels": {"placeholder": "Ask me anything about solar..."},
          "variableId": "var_user_msg"
        },
        "outgoingEdgeId": "edge_welcome_to_ai"
      }
    ],
    "graphCoordinates": {"x": 0, "y": 200}
  },
  {
    "id": "grp_ai_chat",
    "title": "Jennifer AI",
    "blocks": [
      {
        "id": "blk_openai",
        "type": "OpenAI",
        "options": {
          "task": "Create chat completion",
          "model": "qwen3:8b",
          "credentialsId": "cred_ollama_openai",
          "messages": [
            {
              "id": "msg_system",
              "role": "system",
              "content": "You are Jennifer, a friendly solar consultant at Affordable Solar in Norman, Oklahoma.\n\nPERSONALITY:\n- Warm, conversational, approachable\n- Sound like a real person texting, not a corporate bot\n- Confident but never pushy\n- Never reveal you are AI or a chatbot. You are Jennifer.\n- Use casual language. Contractions are fine.\n\nFORMAT RULES:\n- Plain text only. NO markdown. NO bold. NO bullets. NO links. NO emojis.\n- Keep responses to 2-3 short sentences for simple questions.\n- For technical questions, 3-4 sentences max.\n- Write like a text message, not an essay.\n- Vary your openers.\n\nGOAL:\nAnswer questions about solar, batteries and services. Be genuinely helpful. Share real info. Do NOT ask for contact info or push scheduling. Just answer their questions and ask follow-ups to understand their situation.\n\nRULES:\n- Only use facts from the knowledge base below.\n- If unsure, say the team will follow up with details.\n- NEVER mention tax credits, ITC or federal incentives. None are available.\n- NEVER promise specific savings without a consultation.\n- For net metering credits, say blended rate not retail rate.\n- NEVER use: robust, transformative, utilize, synergy, leverage, optimize, streamline.\n\nKNOWLEDGE BASE:\nCompany: Affordable Solar LLC, Norman OK. Phone (405) 400-2836. Hours Mon-Fri 8am-6pm, Sat 9am-2pm. All of Oklahoma.\nFounded 2024, backed by Affordable Construction Co (50+ years). 4.6 stars. 10-year workmanship warranty.\nCertifications: Tesla, FranklinWH, IronRidge certified. Backed by GAF Master Elite certified construction team.\nDifferentiators: locally owned, local crews (not subcontracted), same team does roofing/solar/electrical/battery.\n\nResidential Solar: Tier 1 mono 400-440W panels, Enphase IQ8+ microinverters, IronRidge racking. Average OK home uses 1,100 kWh/month, needs 20-30 panels (7-10 kW). Cost $2.50-$3.00/watt, average $20k-$30k. Timeline 4-8 weeks. All systems battery-ready.\n\nBatteries: EG4 PowerPro (up to 30.72 kWh, 12kW, 10yr, lowest cost). Tesla Powerwall 3 (13.5 kWh, 11.5kW, Storm Watch, 10yr). FranklinWH aPower 2 (15 kWh stackable, 10kW, generator integration, 15yr longest). Single battery installed $10k-$20k.\n\nPricing: $0 down financing available. Cash payback 6-8 years residential. Most see 60-90% bill reduction.\n\nOklahoma: 235 sunny days/year. Rate ~12 cents/kWh, rising ~12% YoY. OGE and PSO approved $246M combined rate increases."
            },
            {
              "id": "msg_dialogue",
              "role": "Dialogue",
              "dialogueVariableId": "var_chat_history",
              "startsBy": "user",
              "isNew": true
            },
            {
              "id": "msg_user",
              "role": "user",
              "content": "{{user_message}}"
            }
          ],
          "responseMapping": [
            {
              "id": "map_response",
              "valueToExtract": "Message content",
              "variableId": "var_llm_response"
            }
          ],
          "temperature": 0.7
        }
      },
      {
        "id": "blk_show_response",
        "type": "text",
        "content": {
          "richText": [
            {
              "type": "p",
              "children": [
                {"text": "{{llm_response}}"}
              ]
            }
          ]
        }
      },
      {
        "id": "blk_choice",
        "type": "choice input",
        "options": {
          "isMultipleChoice": false,
          "buttonLabel": "Send",
          "dynamicVariableId": null
        },
        "items": [
          {
            "id": "item_more_questions",
            "content": "I have more questions",
            "outgoingEdgeId": "edge_more_questions"
          },
          {
            "id": "item_schedule",
            "content": "Schedule a free consultation",
            "outgoingEdgeId": "edge_to_capture"
          }
        ]
      }
    ],
    "graphCoordinates": {"x": 400, "y": 200}
  },
  {
    "id": "grp_more_questions",
    "title": "More Questions",
    "blocks": [
      {
        "id": "blk_followup_input",
        "type": "text input",
        "options": {
          "isLong": false,
          "labels": {"placeholder": "Type your question..."},
          "variableId": "var_user_msg"
        },
        "outgoingEdgeId": "edge_followup_to_ai"
      }
    ],
    "graphCoordinates": {"x": 200, "y": 600}
  },
  {
    "id": "grp_capture",
    "title": "Lead Capture",
    "blocks": [
      {
        "id": "blk_capture_msg",
        "type": "text",
        "content": {
          "richText": [
            {
              "type": "p",
              "children": [
                {"text": "Awesome! Let me get a few details so our team can put together a custom quote for you."}
              ]
            }
          ]
        }
      },
      {
        "id": "blk_get_name",
        "type": "text input",
        "options": {
          "isLong": false,
          "labels": {"placeholder": "Your name"},
          "variableId": "var_name"
        }
      },
      {
        "id": "blk_get_phone",
        "type": "phone number input",
        "options": {
          "labels": {"placeholder": "(405) 555-1234"},
          "variableId": "var_phone",
          "retryMessageContent": "Hmm, that doesn\u0027t look like a valid phone number. Mind trying again?"
        }
      },
      {
        "id": "blk_get_email",
        "type": "email input",
        "options": {
          "labels": {"placeholder": "you@email.com"},
          "variableId": "var_email",
          "retryMessageContent": "That doesn\u0027t look like a valid email. Could you try again?"
        }
      },
      {
        "id": "blk_thank_you",
        "type": "text",
        "content": {
          "richText": [
            {
              "type": "p",
              "children": [
                {"text": "Thanks {{customer_name}}! Our team will reach out shortly to schedule your free consultation. If you need anything, call us at (405) 400-2836."}
              ]
            }
          ]
        }
      }
    ],
    "graphCoordinates": {"x": 800, "y": 200}
  }
]'::jsonb,
"edges" = '[
  {"id": "edge_start_to_welcome", "to": {"groupId": "grp_welcome"}, "from": {"eventId": "ww96h5lwgcj5pya72dt18uok"}},
  {"id": "edge_welcome_to_ai", "to": {"groupId": "grp_ai_chat"}, "from": {"blockId": "blk_welcome_input"}},
  {"id": "edge_more_questions", "to": {"groupId": "grp_more_questions"}, "from": {"blockId": "blk_choice", "itemId": "item_more_questions"}},
  {"id": "edge_to_capture", "to": {"groupId": "grp_capture"}, "from": {"blockId": "blk_choice", "itemId": "item_schedule"}},
  {"id": "edge_followup_to_ai", "to": {"groupId": "grp_ai_chat"}, "from": {"blockId": "blk_followup_input"}}
]'::jsonb
WHERE "id" = 'cmmy41w3m0002my1z919waitb';

-- Sync to Typebot table
UPDATE "Typebot"
SET
  "groups" = (SELECT "groups" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb'),
  "edges" = (SELECT "edges" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb'),
  "variables" = (SELECT "variables" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb')
WHERE "publicId" = 'solar-lead-gen';
