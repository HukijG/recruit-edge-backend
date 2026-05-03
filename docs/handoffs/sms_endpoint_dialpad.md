SMS -- Send

# SMS -- Send

Sends an SMS message to a phone number or to a Dialpad channel on behalf of a user.

Added on Dec 18, 2019 for API v2.

Tier 0 Rate limit: 100 per minute.

Tier 1 Rate limit: 800 per minute.



# OpenAPI definition

```json
{
  "components": {
    "schemas": {
      "protos.sms.SMSProto": {
        "properties": {
          "contact_id": {
            "description": "The ID of the specific contact which SMS should be sent to.",
            "type": [
              "null",
              "string"
            ]
          },
          "created_date": {
            "description": "Date of SMS creation.",
            "format": "date-time",
            "type": [
              "null",
              "string"
            ]
          },
          "device_type": {
            "description": "The device type.",
            "enum": [
              "android",
              "ata",
              "audiocodes",
              "c2t",
              "ciscompp",
              "dect",
              "dpmroom",
              "grandstream",
              "harness",
              "iframe_cti_extension",
              "iframe_cti_v2",
              "iframe_front",
              "iframe_hubspot",
              "iframe_ms_teams",
              "iframe_open_cti",
              "iframe_salesforce",
              "iframe_service_titan",
              "iframe_zendesk",
              "iframe_zoho",
              "ipad",
              "iphone",
              "mini",
              "mitel",
              "msteams",
              "native",
              "obi",
              "packaged_app",
              "polyandroid",
              "polycom",
              "proxy",
              "public_api",
              "salesforce",
              "sip",
              "tickiot",
              "web",
              "yealink"
            ],
            "type": [
              "null",
              "string"
            ]
          },
          "direction": {
            "description": "SMS direction.",
            "enum": [
              "inbound",
              "outbound"
            ],
            "type": [
              "null",
              "string"
            ]
          },
          "from_number": {
            "description": "The phone number from which the SMS was sent.",
            "type": [
              "null",
              "string"
            ]
          },
          "id": {
            "description": "The ID of the SMS.",
            "format": "int64",
            "type": [
              "integer",
              "null"
            ]
          },
          "message_delivery_result": {
            "description": "The final message delivery result.",
            "enum": [
              "accepted",
              "internal_error",
              "invalid_destination",
              "invalid_source",
              "no_route",
              "not_supported",
              "rejected",
              "rejected_spam",
              "time_out"
            ],
            "type": [
              "null",
              "string"
            ]
          },
          "message_status": {
            "description": "The status of the SMS.",
            "enum": [
              "failed",
              "pending",
              "success"
            ],
            "type": [
              "null",
              "string"
            ]
          },
          "target_id": {
            "description": "The target's id.",
            "format": "int64",
            "type": [
              "integer",
              "null"
            ]
          },
          "target_type": {
            "description": "Target's type.",
            "enum": [
              "callcenter",
              "callrouter",
              "channel",
              "coachinggroup",
              "coachingteam",
              "department",
              "office",
              "room",
              "staffgroup",
              "unknown",
              "user"
            ],
            "type": [
              "null",
              "string"
            ]
          },
          "text": {
            "description": "The contents of the message that was sent.",
            "type": [
              "null",
              "string"
            ]
          },
          "to_numbers": {
            "description": "Up to 10 E164-formatted phone numbers who received the SMS.",
            "items": {
              "type": "string"
            },
            "type": [
              "array",
              "null"
            ]
          },
          "user_id": {
            "description": "The ID of the user who sent the SMS.",
            "format": "int64",
            "type": [
              "integer",
              "null"
            ]
          }
        },
        "title": "SMS message.",
        "type": "object"
      },
      "protos.sms.SendSMSMessage": {
        "properties": {
          "channel_hashtag": {
            "description": "[single-line only]\n\nThe hashtag of the channel which should receive the SMS.",
            "type": [
              "null",
              "string"
            ]
          },
          "from_number": {
            "description": "The number of who sending the SMS. The number must be assigned to user or a user group. It will override user_id and sender_group_id.",
            "type": [
              "null",
              "string"
            ]
          },
          "infer_country_code": {
            "default": false,
            "description": "If true, to_numbers will be assumed to be from the specified user's country, and the E164 format requirement will be relaxed.",
            "type": [
              "boolean",
              "null"
            ]
          },
          "media": {
            "description": "Base64-encoded media attachment (will cause the message to be sent as MMS).\n(Max 500 KiB raw file size)",
            "format": "byte",
            "type": [
              "null",
              "string"
            ]
          },
          "sender_group_id": {
            "description": "The ID of an office, department, or call center that the User should send the message on behalf of.",
            "format": "int64",
            "type": [
              "integer",
              "null"
            ]
          },
          "sender_group_type": {
            "description": "The sender group's type (i.e. office, department, or callcenter).",
            "enum": [
              "callcenter",
              "department",
              "office"
            ],
            "type": [
              "null",
              "string"
            ]
          },
          "text": {
            "default": "",
            "description": "The contents of the message that should be sent.",
            "type": [
              "null",
              "string"
            ]
          },
          "to_numbers": {
            "description": "Up to 10 E164-formatted phone numbers who should receive the SMS.",
            "items": {
              "type": "string"
            },
            "type": [
              "array",
              "null"
            ]
          },
          "user_id": {
            "description": "The ID of the user who should be the sender of the SMS.",
            "format": "int64",
            "type": [
              "integer",
              "null"
            ]
          }
        },
        "type": "object"
      }
    },
    "securitySchemes": {
      "bearer_token": {
        "description": "The API key can be put in the Authorization header.\ni.e. Authorization: Bearer <api_key>",
        "scheme": "bearer",
        "type": "http"
      }
    }
  },
  "info": {
    "description": "# Introduction\n\nAdmin API v2 for Dialpad.\n\nRequests and responses from the admin API are provided in the JSON format.\n\n# Pagination\n\nList APIs support a limit and cursor parameter.\n\nThe limit defines the number of results to return. For the first request, pass in a desired limit.\nThe API response will contain a cursor field with a special string. Pass this special string into\nthe next request to retrieve the next page.\n\n# Authentication\n\nAll requests are authenticated via an API key in the query parameter or as a bearer token in the\nAuthorization header.\n\nAn API key can be acquired from the Dialpad admin web portal.\n\nNote: If you received your API key from the Dialpad support team rather than the web portal, the\nuser associated with your key must have company administrator permissions.",
    "title": "API",
    "version": "v2",
    "x-logo": {
      "altText": "Dialpad",
      "url": "https://storage.googleapis.com/dialpad_openapi_specs/logo.png"
    }
  },
  "openapi": "3.1.0",
  "paths": {
    "/api/v2/sms": {
      "post": {
        "deprecated": false,
        "description": "Sends an SMS message to a phone number or to a Dialpad channel on behalf of a user.\n\nAdded on Dec 18, 2019 for API v2.\n\nTier 0 Rate limit: 100 per minute.\n\nTier 1 Rate limit: 800 per minute.\n\n",
        "operationId": "sms.send",
        "parameters": [],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/protos.sms.SendSMSMessage",
                "type": "object"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "examples": {
                  "json_example": {
                    "value": {
                      "contact_id": "1000",
                      "created_date": "2013-01-01T00:00:00",
                      "device_type": "public_api",
                      "direction": "outbound",
                      "from_number": "+14155551001",
                      "id": "1004",
                      "message_status": "pending",
                      "target_id": "2",
                      "target_type": "user",
                      "text": "Test text",
                      "to_numbers": [
                        "+14155557777"
                      ],
                      "user_id": "2"
                    }
                  }
                },
                "schema": {
                  "$ref": "#/components/schemas/protos.sms.SMSProto"
                }
              }
            },
            "description": "A successful response"
          }
        },
        "summary": "SMS -- Send",
        "tags": [
          "sms"
        ],
        "x-ratelimit": [
          [
            100,
            60
          ],
          [
            800,
            60
          ]
        ]
      }
    }
  },
  "security": [
    {
      "bearer_token": []
    }
  ],
  "servers": [
    {
      "url": "https://dialpad.com/"
    },
    {
      "url": "https://sandbox.dialpad.com/"
    }
  ],
  "x-readme": {
    "explorer-enabled": true,
    "proxy-enabled": false,
    "samples-enabled": true
  }
}
```