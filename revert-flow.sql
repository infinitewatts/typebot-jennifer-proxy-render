-- Revert to working webhook flow
UPDATE "PublicTypebot"
SET
"variables" = '[
  {"id": "var_user_msg", "name": "user_message", "isSessionVariable": false},
  {"id": "var_llm_response", "name": "llm_response", "isSessionVariable": false},
  {"id": "var_name", "name": "customer_name", "isSessionVariable": false},
  {"id": "var_phone", "name": "phone", "isSessionVariable": false},
  {"id": "var_email", "name": "email", "isSessionVariable": false},
  {"id": "var_session_id", "name": "session_id", "isSessionVariable": false}
]'::jsonb,
"groups" = '[
  {
    "id": "grp_welcome",
    "title": "Welcome",
    "blocks": [
      {
        "id": "blk_set_session",
        "type": "Set variable",
        "options": {
          "type": "Random ID",
          "variableId": "var_session_id"
        }
      },
      {
        "id": "blk_welcome_msg",
        "type": "text",
        "content": {
          "richText": [
            {
              "type": "p",
              "children": [
                {"text": "hey there, im Jennifer. how can i help?"}
              ]
            }
          ]
        }
      },
      {
        "id": "blk_user_input",
        "type": "text input",
        "options": {
          "isLong": false,
          "labels": {"placeholder": "Type your question..."},
          "variableId": "var_user_msg"
        },
        "outgoingEdgeId": "edge_welcome_to_llm"
      }
    ],
    "graphCoordinates": {"x": -182.79, "y": -131.13}
  },
  {
    "id": "grp_llm",
    "title": "Jennifer AI",
    "blocks": [
      {
        "id": "blk_webhook",
        "type": "Webhook",
        "options": {
          "timeout": 90,
          "webhook": {
            "url": "https://jennifer.affordablesolar.io/chat",
            "body": "{\"message\": \"{{user_message}}\", \"sessionId\": \"{{session_id}}\"}",
            "method": "POST",
            "headers": [{"id": "hdr1", "key": "Content-Type", "value": "application/json"}],
            "queryParams": []
          },
          "isCustomBody": true,
          "isExecutedOnClient": false,
          "responseVariableMapping": [
            {"id": "map1", "bodyPath": "data.response", "variableId": "var_llm_response"}
          ]
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
        "id": "blk_followup_input",
        "type": "text input",
        "options": {
          "isLong": false,
          "labels": {"placeholder": "Type your message..."},
          "variableId": "var_user_msg"
        },
        "outgoingEdgeId": "edge_loop"
      }
    ],
    "graphCoordinates": {"x": -52.77, "y": 554.83}
  }
]'::jsonb,
"edges" = '[
  {"id": "edge_start_to_welcome", "to": {"groupId": "grp_welcome"}, "from": {"eventId": "ww96h5lwgcj5pya72dt18uok"}},
  {"id": "edge_welcome_to_llm", "to": {"groupId": "grp_llm"}, "from": {"blockId": "blk_user_input"}},
  {"id": "edge_loop", "to": {"groupId": "grp_llm"}, "from": {"blockId": "blk_followup_input"}}
]'::jsonb
WHERE "id" = 'cmmy41w3m0002my1z919waitb';

-- Sync to Typebot table
UPDATE "Typebot"
SET
  "groups" = (SELECT "groups" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb'),
  "edges" = (SELECT "edges" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb'),
  "variables" = (SELECT "variables" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb')
WHERE "publicId" = 'solar-lead-gen';
