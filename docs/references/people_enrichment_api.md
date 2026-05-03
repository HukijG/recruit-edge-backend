People Enrichment

# People Enrichment

Use the People Enrichment endpoint to enrich data for 1 person. To enrich data for up to 10 people with a single API call, use the <a href="https://docs.apollo.io/reference/bulk-people-enrichment" target="_blank">Bulk People Enrichment endpoint</a> instead.  <br><br>Apollo relies on the information you pass via the endpoint's parameters to identify the correct person to enrich. If you provide more information about a person, Apollo is more likely to find a match within its database. If you only provide general information, such as a name without a domain or email address, you might receive a 200 response, but the response will indicate that no records have been enriched. <br><br>By default, this endpoint does not return personal emails or phone numbers. Use the `reveal_personal_emails` and `reveal_phone_number` parameters to retrieve emails and phone numbers. <br><br> You can also use the `run_waterfall_email` and `run_waterfall_phone` parameters to run waterfall enrichment via this endpoint. [Waterfall enrichment](https://knowledge.apollo.io/hc/en-us/articles/34071089002509-Waterfall-Enrichment-Overview) gives you broader data coverage by checking connected third-party data sources for contact emails and phone numbers. When you call this endpoint and include at least one waterfall parameter, Apollo returns an immediate synchronous response with demographic and firmographic data, along with a waterfall enrichment request status. Apollo delivers enriched emails and/or phone numbers asynchronously to a configured webhook.<br><br>
**Webhook Response Details:**
- When using native enrichment for phone number enrichment, the webhook response follows: [Native webhook response details](doc:retrieve-mobile-phone-numbers-for-contacts#webhook-response-details)
- When passing Waterfall flags, the webhook response follows: [Waterfall webhook response Details](doc:enrich-phone-and-email-using-data-waterfall#response-details)

**Webhook Requirements:**

- **HTTPS Required:** Your endpoint must be publicly accessible over HTTPS.

- **Rate Limiting:** Ensure your webhook endpoint can handle the volume of webhook traffic sent by Apollo.

- **Idempotency:** Apollo may retry webhook calls; your endpoint should be idempotent to handle duplicate payloads safely.

Using this endpoint will consume credits based on your account's pricing plan. If you run waterfall enrichment parameters, your [credit usage](https://knowledge.apollo.io/hc/en-us/articles/34071089002509-Waterfall-Enrichment-Overview#does-waterfall-enrichment-require-credits) depends on the type of data you request (emails and/or phone numbers) and which data source returns enriched data. To view a summary of Apollo's pricing, visit the  <a href="https://www.apollo.io/pricing" target="_blank"> public pricing page ↗</a> For detailed information regarding API credit usage, see the <a href="https://app.apollo.io/#/settings/credits/about" target="_blank"> API enrichment ↗</a> section on the *About Credits* page (login required).

# OpenAPI definition

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "apollo-rest-api",
    "version": "1.0"
  },
  "servers": [
    {
      "url": "https://api.apollo.io/api/v1"
    }
  ],
  "components": {
    "securitySchemes": {
      "apiKey": {
        "type": "apiKey",
        "in": "header",
        "name": "x-api-key",
        "description": "API key"
      },
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
        "description": "[Recommended] OAuth Access token"
      }
    }
  },
  "security": [
    {
      "bearerAuth": []
    },
    {
      "apiKey": []
    }
  ],
  "paths": {
    "/people/match": {
      "post": {
        "summary": "People Enrichment",
        "description": "Use the People Enrichment endpoint to enrich data for 1 person. To enrich data for up to 10 people with a single API call, use the <a href=\"https://docs.apollo.io/reference/bulk-people-enrichment\" target=\"_blank\">Bulk People Enrichment endpoint</a> instead.  <br><br>Apollo relies on the information you pass via the endpoint's parameters to identify the correct person to enrich. If you provide more information about a person, Apollo is more likely to find a match within its database. If you only provide general information, such as a name without a domain or email address, you might receive a 200 response, but the response will indicate that no records have been enriched. <br><br>By default, this endpoint does not return personal emails or phone numbers. Use the `reveal_personal_emails` and `reveal_phone_number` parameters to retrieve emails and phone numbers. <br><br> You can use also use the `run_waterfall_email` and `run_waterfall_phone` parameters to run waterfall enrichment via this endpoint. [Waterfall enrichment](https://knowledge.apollo.io/hc/en-us/articles/34071089002509-Waterfall-Enrichment-Overview) gives you broader data coverage by checking connected third-party data sources for contact emails and phone numbers. When you call this endpoint and include at least one waterfall parameter, Apollo returns an immediate synchronous response with demographic and firmographic data, along with a waterfall enrichment request status. Apollo delivers enriched emails and/or phone numbers asynchronously to a configured webhook.<br><br> Using this endpoint will consume credits based on your account's pricing plan. If you run waterfall enrichment parameters, your [credit usage](https://knowledge.apollo.io/hc/en-us/articles/34071089002509-Waterfall-Enrichment-Overview#does-waterfall-enrichment-require-credits) depends on the type of data you request (emails and/or phone numbers) and which data source returns enriched data. To view a summary of Apollo's pricing, visit the  <a href=\"https://www.apollo.io/pricing\" target=\"_blank\"> public pricing page ↗</a> For detailed information regarding API credit usage, see the <a href=\"https://app.apollo.io/#/settings/credits/about\" target=\"_blank\"> API enrichment ↗</a> section on the *About Credits* page (login required).",
        "operationId": "people-enrichment",
        "parameters": [
          {
            "name": "first_name",
            "in": "query",
            "description": "The first name of the person. This is typically used in combination with the `last_name` parameter. <br><br>Example: `tim`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "last_name",
            "in": "query",
            "description": "The last name of the person. This is typically used in combination with the `first_name` parameter. <br><br>Example: `zheng`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "query",
            "description": "The full name of the person. This will typically be a first name and last name separated by a space.  If you use this parameter, you do not need to use the `first_name` and `last_name` parameters. <br><br>Example: `tim zheng`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "email",
            "in": "query",
            "description": "The email address of the person. <br><br>Example: `example@email.com`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "hashed_email",
            "in": "query",
            "description": "The hashed email of the person. The email should adhere to either the MD5 or SHA-256 hash format. <br><br>Example: `8d935115b9ff4489f2d1f9249503cadf` (MD5) or `97817c0c49994eb500ad0a5e7e2d8aed51977b26424d508f66e4e8887746a152` (SHA-256)",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "organization_name",
            "in": "query",
            "description": "The name of the person's employer. This can be the current employer or a previous employer. <br><br>Example: `apollo`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "domain",
            "in": "query",
            "description": "The domain name for the person's employer. This can be the current employer or a previous employer. Do not include `www.`, the `@` symbol, or similar. <br><br>Example: `apollo.io` or `microsoft.com`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "id",
            "in": "query",
            "description": "The Apollo ID for the person. Each person in the Apollo database is assigned a unique ID. <br><br>To find IDs, call the <a href=\"https://docs.apollo.io/reference/people-api-search\" target=\"_blank\">People API Search endpoint</a> and identify the values for `person_id`. <br><br>Example: `587cf802f65125cad923a266`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "linkedin_url",
            "in": "query",
            "description": "The URL for the person's LinkedIn profile. <br><br>Example: `http://www.linkedin.com/in/tim-zheng-677ba010`",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "run_waterfall_email",
            "in": "query",
            "description": "Set to true to enable email waterfall enrichment",
            "schema": {
              "type": "boolean",
              "default": false
            }
          },
          {
            "name": "run_waterfall_phone",
            "in": "query",
            "description": "Set to true to enable phone waterfall enrichment",
            "schema": {
              "type": "boolean",
              "default": false
            }
          },
          {
            "name": "reveal_personal_emails",
            "in": "query",
            "description": "Set to `true` if you want to enrich the person's data with personal emails. This potentially consumes credits as part of your <a href=\"https://docs.apollo.io/docs/api-pricing\" target=\"_blank\">Apollo pricing plan</a>. The default value is `false`. <br><br>If a person resides in a <a href=\"https://knowledge.apollo.io/hc/en-us/articles/4409141087757\" target=\"_blank\">GDPR</a>-compliant region, Apollo will not reveal their personal email.",
            "schema": {
              "type": "boolean",
              "default": false
            }
          },
          {
            "name": "reveal_phone_number",
            "in": "query",
            "description": "Set to `true` if you want to enrich the person's data with all available phone numbers, including mobile phone numbers. This potentially consumes credits as part of your <a href=\"https://docs.apollo.io/docs/api-pricing\" target=\"_blank\">Apollo pricing plan</a>. The default value is `false`. <br><br>If this parameter is set to `true`, you must enter a webhook URL for the `webhook_url` parameter. Apollo will asynchronously verify phone numbers for you, then send a JSON response that includes only details about the person's phone numbers to the webhook URL you provide. It can take several minutes for the phone numbers to be delivered.",
            "schema": {
              "type": "boolean",
              "default": false
            }
          },
          {
            "name": "webhook_url",
            "in": "query",
            "description": "If you set the `reveal_phone_number` parameter to `true`, this parameter becomes mandatory. Otherwise, do not use this parameter. <br><br>Enter the webhook URL that specifies where Apollo should send a JSON response that includes the phone number you requested. Apollo suggests testing this flow to ensure you receive the separate response with the phone number. <br><br>If phone numbers are not revealed delivered to the webhook URL, try applying UTF-8 encoding to the webhook URL. <br><br>Example: `https://webhook.site/cc4cf44e-e047-4774-8dac-473d28474e40`; `https%3A%2F%2Fwebhook.site%2Fcc4cf44e-e047-4774-8dac-473d28474e40`",
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "200",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": {
                      "person": {
                        "id": "64a7ff0cc4dfae00013df1a5",
                        "first_name": "Tim",
                        "last_name": "Zheng",
                        "name": "Tim Zheng",
                        "linkedin_url": "http://www.linkedin.com/in/tim-zheng-677ba010",
                        "title": "Founder & CEO",
                        "email_status": "verified",
                        "photo_url": "https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2",
                        "twitter_url": null,
                        "github_url": null,
                        "facebook_url": null,
                        "extrapolated_email_confidence": null,
                        "headline": "Founder & CEO at Apollo",
                        "email": "tim@apollo.io",
                        "organization_id": "5e66b6381e05b4008c8331b8",
                        "employment_history": [
                          {
                            "_id": "66d7af8c200cad0001404c1f",
                            "created_at": null,
                            "current": true,
                            "degree": null,
                            "description": null,
                            "emails": null,
                            "end_date": null,
                            "grade_level": null,
                            "kind": null,
                            "major": null,
                            "organization_id": "5e66b6381e05b4008c8331b8",
                            "organization_name": "Apollo",
                            "raw_address": null,
                            "start_date": "2016-01-01",
                            "title": "Founder & CEO",
                            "updated_at": null,
                            "id": "66d7af8c200cad0001404c1f",
                            "key": "66d7af8c200cad0001404c1f"
                          },
                          {
                            "_id": "66d7af8c200cad0001404c20",
                            "created_at": null,
                            "current": false,
                            "degree": null,
                            "description": null,
                            "emails": null,
                            "end_date": "2015-01-01",
                            "grade_level": null,
                            "kind": null,
                            "major": null,
                            "organization_id": null,
                            "organization_name": "Braingenie",
                            "raw_address": null,
                            "start_date": "2011-01-01",
                            "title": "Founder & CEO",
                            "updated_at": null,
                            "id": "66d7af8c200cad0001404c20",
                            "key": "66d7af8c200cad0001404c20"
                          },
                          {
                            "_id": "66d7af8c200cad0001404c21",
                            "created_at": null,
                            "current": false,
                            "degree": null,
                            "description": null,
                            "emails": null,
                            "end_date": "2011-01-01",
                            "grade_level": null,
                            "kind": null,
                            "major": null,
                            "organization_id": "54a22f23746869331840e813",
                            "organization_name": "Citadel Investment Group",
                            "raw_address": null,
                            "start_date": "2011-01-01",
                            "title": "Investment & Trading Associate",
                            "updated_at": null,
                            "id": "66d7af8c200cad0001404c21",
                            "key": "66d7af8c200cad0001404c21"
                          },
                          {
                            "_id": "66d7af8c200cad0001404c22",
                            "created_at": null,
                            "current": false,
                            "degree": null,
                            "description": null,
                            "emails": null,
                            "end_date": "2010-09-01",
                            "grade_level": null,
                            "kind": null,
                            "major": null,
                            "organization_id": "54a1216169702d7fe6dfca02",
                            "organization_name": "The Boston Consulting Group",
                            "raw_address": null,
                            "start_date": "2010-08-01",
                            "title": "Summer Associate",
                            "updated_at": null,
                            "id": "66d7af8c200cad0001404c22",
                            "key": "66d7af8c200cad0001404c22"
                          },
                          {
                            "_id": "66d7af8c200cad0001404c23",
                            "created_at": null,
                            "current": false,
                            "degree": null,
                            "description": null,
                            "emails": null,
                            "end_date": "2010-08-01",
                            "grade_level": null,
                            "kind": null,
                            "major": null,
                            "organization_id": "5da2e6a3f978a8000177e831",
                            "organization_name": "Goldman Sachs",
                            "raw_address": null,
                            "start_date": "2010-06-01",
                            "title": "Summer Analyst",
                            "updated_at": null,
                            "id": "66d7af8c200cad0001404c23",
                            "key": "66d7af8c200cad0001404c23"
                          },
                          {
                            "_id": "66d7af8c200cad0001404c24",
                            "created_at": null,
                            "current": false,
                            "degree": null,
                            "description": null,
                            "emails": null,
                            "end_date": "2010-02-01",
                            "grade_level": null,
                            "kind": null,
                            "major": null,
                            "organization_id": "54a1a06274686945fa1ffc02",
                            "organization_name": "Jane Street",
                            "raw_address": null,
                            "start_date": "2009-12-01",
                            "title": "Trading Intern",
                            "updated_at": null,
                            "id": "66d7af8c200cad0001404c24",
                            "key": "66d7af8c200cad0001404c24"
                          }
                        ],
                        "state": "California",
                        "city": "San Francisco",
                        "country": "United States",
                        "contact_id": "664fa05cf8299f0001f90876",
                        "contact": {
                          "contact_roles": [],
                          "id": "664fa05cf8299f0001f90876",
                          "first_name": "Roy",
                          "last_name": "Chung",
                          "name": "Roy Chung",
                          "linkedin_url": "http://www.linkedin.com/in/tim-zheng-677ba010",
                          "title": "Reaching Peak Potential 💪⛰️📈🧪️ | President",
                          "contact_stage_id": "6095a710bd01d100a506d4ae",
                          "owner_id": null,
                          "creator_id": "66302798d03b9601c7934ec2",
                          "person_id": "64a7ff0cc4dfae00013df1a5",
                          "email_needs_tickling": null,
                          "organization_name": "Apollo.io",
                          "source": "crm",
                          "original_source": "crm",
                          "organization_id": "5e66b6381e05b4008c8331b8",
                          "headline": "Reaching Peak Potential 💪⛰️📈🧪️ | President at FRC",
                          "photo_url": null,
                          "present_raw_address": "New York, New York, United States",
                          "linkedin_uid": null,
                          "extrapolated_email_confidence": null,
                          "salesforce_id": null,
                          "salesforce_lead_id": null,
                          "salesforce_contact_id": null,
                          "salesforce_account_id": null,
                          "crm_owner_id": null,
                          "created_at": "2024-05-23T20:00:28.527Z",
                          "emailer_campaign_ids": [],
                          "direct_dial_status": null,
                          "direct_dial_enrichment_failed_at": null,
                          "email_status": "verified",
                          "email_source": null,
                          "account_id": "6658955877a2f20001c648ac",
                          "last_activity_date": null,
                          "hubspot_vid": null,
                          "hubspot_company_id": null,
                          "crm_id": null,
                          "sanitized_phone": "+11234567890",
                          "merged_crm_ids": null,
                          "updated_at": "2024-06-02T08:53:51.266Z",
                          "queued_for_crm_push": null,
                          "suggested_from_rule_engine_config_id": null,
                          "email_unsubscribed": null,
                          "label_ids": [],
                          "has_pending_email_arcgate_request": false,
                          "has_email_arcgate_request": false,
                          "existence_level": "invisible",
                          "email": "roy@apollo.io",
                          "email_from_customer": true,
                          "typed_custom_fields": {},
                          "custom_field_errors": null,
                          "crm_record_url": null,
                          "email_status_unavailable_reason": null,
                          "email_true_status": "Verified",
                          "updated_email_true_status": false,
                          "contact_rule_config_statuses": [],
                          "source_display_name": "Imported from CRM",
                          "contact_emails": [
                            {
                              "email": "roy@apollo.iorrr",
                              "email_md5": "879440a4afe6515e2de11dd7c531b770",
                              "email_sha256": "354f0caf2a603f6bd8e1646693ad829615254584fd83692766ac2db3aaa58e0f",
                              "email_status": "verified",
                              "email_source": null,
                              "extrapolated_email_confidence": null,
                              "position": 0,
                              "email_from_customer": null,
                              "free_domain": false
                            }
                          ],
                          "time_zone": "America/Los_Angeles",
                          "phone_numbers": [
                            {
                              "raw_number": "(123) 456-7890",
                              "sanitized_number": "+11234567890",
                              "type": null,
                              "position": 0,
                              "status": "valid_number",
                              "dnc_status": null,
                              "dnc_other_info": null,
                              "dialer_flags": null
                            },
                            {
                              "raw_number": "(123) 456-1234",
                              "sanitized_number": "+11234561234",
                              "type": null,
                              "position": 1,
                              "status": "valid_number",
                              "dnc_status": null,
                              "dnc_other_info": null,
                              "dialer_flags": null
                            },
                            {
                              "raw_number": "+1-415-763-6055",
                              "sanitized_number": "+14155550143",
                              "type": null,
                              "position": 2,
                              "status": "valid_number",
                              "dnc_status": null,
                              "dnc_other_info": null,
                              "dialer_flags": {
                                "country_name": "United States",
                                "country_enabled": true,
                                "high_risk_calling_enabled": false,
                                "potential_high_risk_number": false
                              }
                            }
                          ],
                          "account_phone_note": null,
                          "free_domain": false,
                          "is_likely_to_engage": false
                        },
                        "revealed_for_current_team": true,
                        "organization": {
                          "id": "5e66b6381e05b4008c8331b8",
                          "name": "Apollo.io",
                          "website_url": "http://www.apollo.io",
                          "blog_url": null,
                          "angellist_url": null,
                          "linkedin_url": "http://www.linkedin.com/company/apolloio",
                          "twitter_url": "https://twitter.com/meetapollo/",
                          "facebook_url": "https://www.facebook.com/MeetApollo",
                          "primary_phone": {},
                          "languages": [],
                          "alexa_ranking": 3514,
                          "phone": null,
                          "linkedin_uid": "18511550",
                          "founded_year": 2015,
                          "publicly_traded_symbol": null,
                          "publicly_traded_exchange": null,
                          "logo_url": "https://zenprospect-production.s3.amazonaws.com/uploads/pictures/66d13c8d98ec9600013525b8/picture",
                          "crunchbase_url": null,
                          "primary_domain": "apollo.io",
                          "industry": "information technology & services",
                          "keywords": [
                            "sales engagement",
                            "lead generation",
                            "predictive analytics",
                            "lead scoring",
                            "sales strategy",
                            "conversation intelligence",
                            "sales enablement",
                            "lead routing",
                            "sales development",
                            "email engagement",
                            "revenue intelligence",
                            "sales operations",
                            "sales intelligence",
                            "lead intelligence",
                            "prospecting",
                            "b2b data"
                          ],
                          "estimated_num_employees": 1600,
                          "industries": [
                            "information technology & services"
                          ],
                          "secondary_industries": [],
                          "snippets_loaded": true,
                          "industry_tag_id": "5567cd4773696439b10b0000",
                          "industry_tag_hash": {
                            "information technology & services": "5567cd4773696439b10b0000"
                          },
                          "retail_location_count": 0,
                          "raw_address": "415 Mission St, Floor 37, San Francisco, California 94105, US",
                          "street_address": "415 Mission St",
                          "city": "San Francisco",
                          "state": "California",
                          "postal_code": "94105-2301",
                          "country": "United States",
                          "owned_by_organization_id": null,
                          "seo_description": "Search, engage, and convert over 275 million contacts at over 73 million companies with Apollo's sales intelligence and engagement platform.",
                          "short_description": "Apollo.io combines a buyer database of over 270M contacts and powerful sales engagement and automation tools in one, easy to use platform. Trusted by over 160,000 companies including Autodesk, Rippling, Deel, Jasper.ai, Divvy, and Heap, Apollo has more than one million users globally. By helping sales professionals find their ideal buyers and intelligently automate outreach, Apollo helps go-to-market teams sell anything.\n\nCelebrating a $100M Series D Funding Round 🦄",
                          "suborganizations": [],
                          "num_suborganizations": 0,
                          "annual_revenue_printed": "100M",
                          "annual_revenue": 100000000,
                          "total_funding": 251200000,
                          "total_funding_printed": "251.2M",
                          "latest_funding_round_date": "2023-08-01T00:00:00.000+00:00",
                          "latest_funding_stage": "Series D",
                          "funding_events": [
                            {
                              "id": "6574c1ff9b797d0001fdab1b",
                              "date": "2023-08-01T00:00:00.000+00:00",
                              "news_url": null,
                              "type": "Series D",
                              "investors": "Bain Capital Ventures, Sequoia Capital, Tribe Capital, Nexus Venture Partners",
                              "amount": "100M",
                              "currency": "$"
                            },
                            {
                              "id": "624f4dfec786590001768016",
                              "date": "2022-03-01T00:00:00.000+00:00",
                              "news_url": null,
                              "type": "Series C",
                              "investors": "Sequoia Capital, Tribe Capital, Nexus Venture Partners, NewView Capital",
                              "amount": "110M",
                              "currency": "$"
                            },
                            {
                              "id": "61b13677623110000186a478",
                              "date": "2021-10-01T00:00:00.000+00:00",
                              "news_url": null,
                              "type": "Series B",
                              "investors": "Tribe Capital, NewView Capital, Nexus Venture Partners",
                              "amount": "32M",
                              "currency": "$"
                            },
                            {
                              "id": "5ffe93caa54d75077c59acef",
                              "date": "2018-06-26T00:00:00.000+00:00",
                              "news_url": "https://techcrunch.com/2018/06/26/yc-grad-zenprospect-rebrands-as-apollo-lands-7-m-series-a/",
                              "type": "Series A",
                              "investors": "Nexus Venture Partners, Social Capital, Y Combinator",
                              "amount": "7M",
                              "currency": "$"
                            },
                            {
                              "id": "6574c1ff9b797d0001fdab20",
                              "date": "2016-10-01T00:00:00.000+00:00",
                              "news_url": null,
                              "type": "Other",
                              "investors": "Y Combinator, SV Angel, Social Capital, Nexus Venture Partners",
                              "amount": "2.2M",
                              "currency": "$"
                            }
                          ],
                          "technology_names": [
                            "AI",
                            "Android",
                            "Basis",
                            "Canva",
                            "Circle",
                            "CloudFlare Hosting",
                            "Cloudflare DNS",
                            "Drift",
                            "Gmail",
                            "Google Apps",
                            "Google Tag Manager",
                            "Google Workspace",
                            "Gravity Forms",
                            "Hubspot",
                            "Intercom",
                            "Mailchimp Mandrill",
                            "Marketo",
                            "Microsoft Office 365",
                            "Mobile Friendly",
                            "Python",
                            "Rackspace MailGun",
                            "Remote",
                            "Render",
                            "Reviews",
                            "Salesforce",
                            "Stripe",
                            "Typekit",
                            "WP Engine",
                            "Wistia",
                            "WordPress.org",
                            "Yandex Metrica",
                            "reCAPTCHA"
                          ],
                          "current_technologies": [
                            {
                              "uid": "ai",
                              "name": "AI",
                              "category": "Other"
                            },
                            {
                              "uid": "android",
                              "name": "Android",
                              "category": "Frameworks and Programming Languages"
                            },
                            {
                              "uid": "basis",
                              "name": "Basis",
                              "category": "Advertising Networks"
                            },
                            {
                              "uid": "canva",
                              "name": "Canva",
                              "category": "Content Management Platform"
                            },
                            {
                              "uid": "circle",
                              "name": "Circle",
                              "category": "Financial Software"
                            },
                            {
                              "uid": "cloudflare_hosting",
                              "name": "CloudFlare Hosting",
                              "category": "Hosting"
                            },
                            {
                              "uid": "cloudflare_dns",
                              "name": "Cloudflare DNS",
                              "category": "Domain Name Services"
                            },
                            {
                              "uid": "drift",
                              "name": "Drift",
                              "category": "Widgets"
                            },
                            {
                              "uid": "gmail",
                              "name": "Gmail",
                              "category": "Email Providers"
                            },
                            {
                              "uid": "google_apps",
                              "name": "Google Apps",
                              "category": "Other"
                            },
                            {
                              "uid": "google_tag_manager",
                              "name": "Google Tag Manager",
                              "category": "Tag Management"
                            },
                            {
                              "uid": "google workspace",
                              "name": "Google Workspace",
                              "category": "Cloud Services"
                            },
                            {
                              "uid": "gravity_forms",
                              "name": "Gravity Forms",
                              "category": "Hosted Forms"
                            },
                            {
                              "uid": "hubspot",
                              "name": "Hubspot",
                              "category": "Marketing Automation"
                            },
                            {
                              "uid": "intercom",
                              "name": "Intercom",
                              "category": "Support and Feedback"
                            },
                            {
                              "uid": "mailchimp_mandrill",
                              "name": "Mailchimp Mandrill",
                              "category": "Email Delivery"
                            },
                            {
                              "uid": "marketo",
                              "name": "Marketo",
                              "category": "Marketing Automation"
                            },
                            {
                              "uid": "office_365",
                              "name": "Microsoft Office 365",
                              "category": "Other"
                            },
                            {
                              "uid": "mobile_friendly",
                              "name": "Mobile Friendly",
                              "category": "Other"
                            },
                            {
                              "uid": "python",
                              "name": "Python",
                              "category": "Frameworks and Programming Languages"
                            },
                            {
                              "uid": "rackspace_mailgun",
                              "name": "Rackspace MailGun",
                              "category": "Email Delivery"
                            },
                            {
                              "uid": "remote",
                              "name": "Remote",
                              "category": "Other"
                            },
                            {
                              "uid": "render",
                              "name": "Render",
                              "category": "Other"
                            },
                            {
                              "uid": "reviews",
                              "name": "Reviews",
                              "category": "Customer Reviews"
                            },
                            {
                              "uid": "salesforce",
                              "name": "Salesforce",
                              "category": "Customer Relationship Management"
                            },
                            {
                              "uid": "stripe",
                              "name": "Stripe",
                              "category": "Payments"
                            },
                            {
                              "uid": "typekit",
                              "name": "Typekit",
                              "category": "Fonts"
                            },
                            {
                              "uid": "wp_engine",
                              "name": "WP Engine",
                              "category": "CMS"
                            },
                            {
                              "uid": "wistia",
                              "name": "Wistia",
                              "category": "Online Video Platforms"
                            },
                            {
                              "uid": "wordpress_org",
                              "name": "WordPress.org",
                              "category": "CMS"
                            },
                            {
                              "uid": "yandex_metrika",
                              "name": "Yandex Metrica",
                              "category": "Analytics and Tracking"
                            },
                            {
                              "uid": "recaptcha",
                              "name": "reCAPTCHA",
                              "category": "Captcha"
                            }
                          ],
                          "org_chart_root_people_ids": [
                            "652fc57e2802bf00010c52f8"
                          ],
                          "org_chart_sector": "OrgChart::SectorHierarchy::Rules::IT",
                          "org_chart_removed": false,
                          "org_chart_show_department_filter": true
                        },
                        "is_likely_to_engage": true,
                        "intent_strength": null,
                        "show_intent": false,
                        "departments": [
                          "c_suite"
                        ],
                        "subdepartments": [
                          "executive",
                          "founder"
                        ],
                        "functions": [
                          "entrepreneurship"
                        ],
                        "seniority": "founder"
                      },
                      "waterfall": {
                        "status": "accepted",
                        "message": "Waterfall enrichment request accepted. Results will be sent to the provided webhook URL."
                      }
                    }
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "person": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "example": "64a7ff0cc4dfae00013df1a5"
                        },
                        "first_name": {
                          "type": "string",
                          "example": "Tim"
                        },
                        "last_name": {
                          "type": "string",
                          "example": "Zheng"
                        },
                        "name": {
                          "type": "string",
                          "example": "Tim Zheng"
                        },
                        "linkedin_url": {
                          "type": "string",
                          "example": "http://www.linkedin.com/in/tim-zheng-677ba010"
                        },
                        "title": {
                          "type": "string",
                          "example": "Founder & CEO"
                        },
                        "email_status": {
                          "type": "string",
                          "example": "verified"
                        },
                        "photo_url": {
                          "type": "string",
                          "example": "https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2"
                        },
                        "twitter_url": {},
                        "github_url": {},
                        "facebook_url": {},
                        "extrapolated_email_confidence": {},
                        "headline": {
                          "type": "string",
                          "example": "Founder & CEO at Apollo"
                        },
                        "email": {
                          "type": "string",
                          "example": "tim@apollo.io"
                        },
                        "organization_id": {
                          "type": "string",
                          "example": "5e66b6381e05b4008c8331b8"
                        },
                        "employment_history": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "_id": {
                                "type": "string",
                                "example": "66d7af8c200cad0001404c1f"
                              },
                              "created_at": {},
                              "current": {
                                "type": "boolean",
                                "example": true,
                                "default": true
                              },
                              "degree": {},
                              "description": {},
                              "emails": {},
                              "end_date": {},
                              "grade_level": {},
                              "kind": {},
                              "major": {},
                              "organization_id": {
                                "type": "string",
                                "example": "5e66b6381e05b4008c8331b8"
                              },
                              "organization_name": {
                                "type": "string",
                                "example": "Apollo"
                              },
                              "raw_address": {},
                              "start_date": {
                                "type": "string",
                                "example": "2016-01-01"
                              },
                              "title": {
                                "type": "string",
                                "example": "Founder & CEO"
                              },
                              "updated_at": {},
                              "id": {
                                "type": "string",
                                "example": "66d7af8c200cad0001404c1f"
                              },
                              "key": {
                                "type": "string",
                                "example": "66d7af8c200cad0001404c1f"
                              }
                            }
                          }
                        },
                        "state": {
                          "type": "string",
                          "example": "California"
                        },
                        "city": {
                          "type": "string",
                          "example": "San Francisco"
                        },
                        "country": {
                          "type": "string",
                          "example": "United States"
                        },
                        "contact_id": {
                          "type": "string",
                          "example": "664fa05cf8299f0001f90876"
                        },
                        "contact": {
                          "type": "object",
                          "properties": {
                            "contact_roles": {
                              "type": "array"
                            },
                            "id": {
                              "type": "string",
                              "example": "664fa05cf8299f0001f90876"
                            },
                            "first_name": {
                              "type": "string",
                              "example": "Roy"
                            },
                            "last_name": {
                              "type": "string",
                              "example": "Chung"
                            },
                            "name": {
                              "type": "string",
                              "example": "Roy Chung"
                            },
                            "linkedin_url": {
                              "type": "string",
                              "example": "http://www.linkedin.com/in/tim-zheng-677ba010"
                            },
                            "title": {
                              "type": "string",
                              "example": "Reaching Peak Potential 💪⛰️📈🧪️ | President"
                            },
                            "contact_stage_id": {
                              "type": "string",
                              "example": "6095a710bd01d100a506d4ae"
                            },
                            "owner_id": {},
                            "creator_id": {
                              "type": "string",
                              "example": "66302798d03b9601c7934ec2"
                            },
                            "person_id": {
                              "type": "string",
                              "example": "64a7ff0cc4dfae00013df1a5"
                            },
                            "email_needs_tickling": {},
                            "organization_name": {
                              "type": "string",
                              "example": "Apollo.io"
                            },
                            "source": {
                              "type": "string",
                              "example": "crm"
                            },
                            "original_source": {
                              "type": "string",
                              "example": "crm"
                            },
                            "organization_id": {
                              "type": "string",
                              "example": "5e66b6381e05b4008c8331b8"
                            },
                            "headline": {
                              "type": "string",
                              "example": "Reaching Peak Potential 💪⛰️📈🧪️ | President at FRC"
                            },
                            "photo_url": {},
                            "present_raw_address": {
                              "type": "string",
                              "example": "New York, New York, United States"
                            },
                            "linkedin_uid": {},
                            "extrapolated_email_confidence": {},
                            "salesforce_id": {},
                            "salesforce_lead_id": {},
                            "salesforce_contact_id": {},
                            "salesforce_account_id": {},
                            "crm_owner_id": {},
                            "created_at": {
                              "type": "string",
                              "example": "2024-05-23T20:00:28.527Z"
                            },
                            "emailer_campaign_ids": {
                              "type": "array"
                            },
                            "direct_dial_status": {},
                            "direct_dial_enrichment_failed_at": {},
                            "email_status": {
                              "type": "string",
                              "example": "verified"
                            },
                            "email_source": {},
                            "account_id": {
                              "type": "string",
                              "example": "6658955877a2f20001c648ac"
                            },
                            "last_activity_date": {},
                            "hubspot_vid": {},
                            "hubspot_company_id": {},
                            "crm_id": {},
                            "sanitized_phone": {
                              "type": "string",
                              "example": "+11234567890"
                            },
                            "merged_crm_ids": {},
                            "updated_at": {
                              "type": "string",
                              "example": "2024-06-02T08:53:51.266Z"
                            },
                            "queued_for_crm_push": {},
                            "suggested_from_rule_engine_config_id": {},
                            "email_unsubscribed": {},
                            "label_ids": {
                              "type": "array"
                            },
                            "has_pending_email_arcgate_request": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "has_email_arcgate_request": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "existence_level": {
                              "type": "string",
                              "example": "invisible"
                            },
                            "email": {
                              "type": "string",
                              "example": "roy@apollo.io"
                            },
                            "email_from_customer": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            },
                            "typed_custom_fields": {
                              "type": "object",
                              "properties": {}
                            },
                            "custom_field_errors": {},
                            "crm_record_url": {},
                            "email_status_unavailable_reason": {},
                            "email_true_status": {
                              "type": "string",
                              "example": "Verified"
                            },
                            "updated_email_true_status": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "contact_rule_config_statuses": {
                              "type": "array"
                            },
                            "source_display_name": {
                              "type": "string",
                              "example": "Imported from CRM"
                            },
                            "contact_emails": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "email": {
                                    "type": "string",
                                    "example": "roy@apollo.iorrr"
                                  },
                                  "email_md5": {
                                    "type": "string",
                                    "example": "879440a4afe6515e2de11dd7c531b770"
                                  },
                                  "email_sha256": {
                                    "type": "string",
                                    "example": "354f0caf2a603f6bd8e1646693ad829615254584fd83692766ac2db3aaa58e0f"
                                  },
                                  "email_status": {
                                    "type": "string",
                                    "example": "verified"
                                  },
                                  "email_source": {},
                                  "extrapolated_email_confidence": {},
                                  "position": {
                                    "type": "integer",
                                    "example": 0,
                                    "default": 0
                                  },
                                  "email_from_customer": {},
                                  "free_domain": {
                                    "type": "boolean",
                                    "example": false,
                                    "default": true
                                  }
                                }
                              }
                            },
                            "time_zone": {
                              "type": "string",
                              "example": "America/Los_Angeles"
                            },
                            "phone_numbers": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "raw_number": {
                                    "type": "string",
                                    "example": "(123) 456-7890"
                                  },
                                  "sanitized_number": {
                                    "type": "string",
                                    "example": "+11234567890"
                                  },
                                  "type": {},
                                  "position": {
                                    "type": "integer",
                                    "example": 0,
                                    "default": 0
                                  },
                                  "status": {
                                    "type": "string",
                                    "example": "valid_number"
                                  },
                                  "dnc_status": {},
                                  "dnc_other_info": {},
                                  "dialer_flags": {}
                                }
                              }
                            },
                            "account_phone_note": {},
                            "free_domain": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "is_likely_to_engage": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            }
                          }
                        },
                        "revealed_for_current_team": {
                          "type": "boolean",
                          "example": true,
                          "default": true
                        },
                        "organization": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "string",
                              "example": "5e66b6381e05b4008c8331b8"
                            },
                            "name": {
                              "type": "string",
                              "example": "Apollo.io"
                            },
                            "website_url": {
                              "type": "string",
                              "example": "http://www.apollo.io"
                            },
                            "blog_url": {},
                            "angellist_url": {},
                            "linkedin_url": {
                              "type": "string",
                              "example": "http://www.linkedin.com/company/apolloio"
                            },
                            "twitter_url": {
                              "type": "string",
                              "example": "https://twitter.com/meetapollo/"
                            },
                            "facebook_url": {
                              "type": "string",
                              "example": "https://www.facebook.com/MeetApollo"
                            },
                            "primary_phone": {
                              "type": "object",
                              "properties": {}
                            },
                            "languages": {
                              "type": "array"
                            },
                            "alexa_ranking": {
                              "type": "integer",
                              "example": 3514,
                              "default": 0
                            },
                            "phone": {},
                            "linkedin_uid": {
                              "type": "string",
                              "example": "18511550"
                            },
                            "founded_year": {
                              "type": "integer",
                              "example": 2015,
                              "default": 0
                            },
                            "publicly_traded_symbol": {},
                            "publicly_traded_exchange": {},
                            "logo_url": {
                              "type": "string",
                              "example": "https://zenprospect-production.s3.amazonaws.com/uploads/pictures/66d13c8d98ec9600013525b8/picture"
                            },
                            "crunchbase_url": {},
                            "primary_domain": {
                              "type": "string",
                              "example": "apollo.io"
                            },
                            "industry": {
                              "type": "string",
                              "example": "information technology & services"
                            },
                            "keywords": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "example": "sales engagement"
                              }
                            },
                            "estimated_num_employees": {
                              "type": "integer",
                              "example": 1600,
                              "default": 0
                            },
                            "industries": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "example": "information technology & services"
                              }
                            },
                            "secondary_industries": {
                              "type": "array"
                            },
                            "snippets_loaded": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            },
                            "industry_tag_id": {
                              "type": "string",
                              "example": "5567cd4773696439b10b0000"
                            },
                            "industry_tag_hash": {
                              "type": "object",
                              "properties": {
                                "information technology & services": {
                                  "type": "string",
                                  "example": "5567cd4773696439b10b0000"
                                }
                              }
                            },
                            "retail_location_count": {
                              "type": "integer",
                              "example": 0,
                              "default": 0
                            },
                            "raw_address": {
                              "type": "string",
                              "example": "415 Mission St, Floor 37, San Francisco, California 94105, US"
                            },
                            "street_address": {
                              "type": "string",
                              "example": "415 Mission St"
                            },
                            "city": {
                              "type": "string",
                              "example": "San Francisco"
                            },
                            "state": {
                              "type": "string",
                              "example": "California"
                            },
                            "postal_code": {
                              "type": "string",
                              "example": "94105-2301"
                            },
                            "country": {
                              "type": "string",
                              "example": "United States"
                            },
                            "owned_by_organization_id": {},
                            "seo_description": {
                              "type": "string",
                              "example": "Search, engage, and convert over 275 million contacts at over 73 million companies with Apollo's sales intelligence and engagement platform."
                            },
                            "short_description": {
                              "type": "string",
                              "example": "Apollo.io combines a buyer database of over 270M contacts and powerful sales engagement and automation tools in one, easy to use platform. Trusted by over 160,000 companies including Autodesk, Rippling, Deel, Jasper.ai, Divvy, and Heap, Apollo has more than one million users globally. By helping sales professionals find their ideal buyers and intelligently automate outreach, Apollo helps go-to-market teams sell anything.\n\nCelebrating a $100M Series D Funding Round 🦄"
                            },
                            "suborganizations": {
                              "type": "array"
                            },
                            "num_suborganizations": {
                              "type": "integer",
                              "example": 0,
                              "default": 0
                            },
                            "annual_revenue_printed": {
                              "type": "string",
                              "example": "100M"
                            },
                            "annual_revenue": {
                              "type": "integer",
                              "example": 100000000,
                              "default": 0
                            },
                            "total_funding": {
                              "type": "integer",
                              "example": 251200000,
                              "default": 0
                            },
                            "total_funding_printed": {
                              "type": "string",
                              "example": "251.2M"
                            },
                            "latest_funding_round_date": {
                              "type": "string",
                              "example": "2023-08-01T00:00:00.000+00:00"
                            },
                            "latest_funding_stage": {
                              "type": "string",
                              "example": "Series D"
                            },
                            "funding_events": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "type": "string",
                                    "example": "6574c1ff9b797d0001fdab1b"
                                  },
                                  "date": {
                                    "type": "string",
                                    "example": "2023-08-01T00:00:00.000+00:00"
                                  },
                                  "news_url": {},
                                  "type": {
                                    "type": "string",
                                    "example": "Series D"
                                  },
                                  "investors": {
                                    "type": "string",
                                    "example": "Bain Capital Ventures, Sequoia Capital, Tribe Capital, Nexus Venture Partners"
                                  },
                                  "amount": {
                                    "type": "string",
                                    "example": "100M"
                                  },
                                  "currency": {
                                    "type": "string",
                                    "example": "$"
                                  }
                                }
                              }
                            },
                            "technology_names": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "example": "AI"
                              }
                            },
                            "current_technologies": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "uid": {
                                    "type": "string",
                                    "example": "ai"
                                  },
                                  "name": {
                                    "type": "string",
                                    "example": "AI"
                                  },
                                  "category": {
                                    "type": "string",
                                    "example": "Other"
                                  }
                                }
                              }
                            },
                            "org_chart_root_people_ids": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "example": "652fc57e2802bf00010c52f8"
                              }
                            },
                            "org_chart_sector": {
                              "type": "string",
                              "example": "OrgChart::SectorHierarchy::Rules::IT"
                            },
                            "org_chart_removed": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "org_chart_show_department_filter": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            }
                          }
                        },
                        "is_likely_to_engage": {
                          "type": "boolean",
                          "example": true,
                          "default": true
                        },
                        "intent_strength": {},
                        "show_intent": {
                          "type": "boolean",
                          "example": false,
                          "default": true
                        },
                        "departments": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "example": "c_suite"
                          }
                        },
                        "subdepartments": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "example": "executive"
                          }
                        },
                        "functions": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "example": "entrepreneurship"
                          }
                        },
                        "seniority": {
                          "type": "string",
                          "example": "founder"
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "401",
            "content": {
              "text/plain": {
                "examples": {
                  "Check API key": {
                    "value": "Invalid access credentials."
                  }
                }
              }
            }
          },
          "429": {
            "description": "429",
            "content": {
              "application/json": {
                "examples": {
                  "Too many requests": {
                    "value": {
                      "message": "The maximum number of api calls allowed for api/v1/people/match is 600 times per hour. Please upgrade your plan from https://app.apollo.io/#/settings/plans/upgrade."
                    }
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "message": {
                      "type": "string",
                      "example": "The maximum number of api calls allowed for api/v1/people/match is 600 times per hour. Please upgrade your plan from https://app.apollo.io/#/settings/plans/upgrade."
                    }
                  }
                }
              }
            }
          }
        },
        "deprecated": false
      }
    }
  },
  "x-readme": {
    "headers": [
      {
        "key": "Cache-Control",
        "value": "no-cache"
      },
      {
        "key": "Content-Type",
        "value": "application/json"
      }
    ],
    "explorer-enabled": true,
    "proxy-enabled": true
  },
  "x-readme-fauxas": true
}
```