People API Search

# People API Search

Use the People API Search endpoint to find net new people in the Apollo database. Several filters are available to help narrow your search. <br><br> This endpoint is optimized for API usage and does not consume credits. This endpoint is primarily designed for prospecting net new people. <br><br> This endpoint does not return email addresses or phone numbers. Use the <a href="https://docs.apollo.io/reference/people-enrichment" target="_blank">People Enrichment</a> or <a href="https://docs.apollo.io/reference/bulk-people-enrichment" target="_blank">Bulk People Enrichment</a> endpoints to enrich data. This endpoint requires a master API key. Refer to <a href="https://docs.apollo.io/docs/create-api-key" target="_blank">Create API Keys</a> to learn how to create a master API key. <br><br> <br><br>To protect Apollo's performance for all users, this endpoint has a display limit of 50,000 records (100 records per page, up to 500 pages). Add more filters to narrow your search results as much as possible. This limitation does not restrict your access to Apollo's database; you just need to access the data in batches.

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
    "/mixed_people/api_search": {
      "post": {
        "summary": "People API Search",
        "description": "Use the People API Search endpoint to find net new people in the Apollo database. Several filters are available to help narrow your search. <br><br>This endpoint is optimized for API usage and does not consume credits. This endpoint is primarily designed for prospecting net new people.<br><br>This endpoint does not return email addresses or phone numbers. Use the <a href=\"https://docs.apollo.io/reference/people-enrichment\" target=\"_blank\">People Enrichment</a> or <a href=\"https://docs.apollo.io/reference/bulk-people-enrichment\" target=\"_blank\">Bulk People Enrichment</a> endpoints to enrich data. <br><br>This endpoint requires a master API key. Refer to <a href=\"https://docs.apollo.io/docs/create-api-key\" target=\"_blank\">Create API Keys</a> to learn how to create a master API key. <br><br>To protect Apollo's performance for all users, this endpoint has a display limit of 50,000 records (100 records per page, up to 500 pages). Add more filters to narrow your search results as much as possible. This limitation does not restrict your access to Apollo's database; you just need to access the data in batches.",
        "operationId": "people-api-search",
        "parameters": [
          {
            "name": "person_titles[]",
            "in": "query",
            "description": "Job titles held by the people you want to find. For a person to be included in search results, they only need to match 1 of the job titles you add. Adding more job titles expands your search results. <br><br>Results also include job titles with the same terms, even if they are not exact matches. For example, searching for `marketing manager` might return people with the job title `content marketing manager`. <br><br>Use this parameter in combination with the `person_seniorities[]` parameter to find people based on specific job functions and seniority levels. <br><br>Examples: `sales development representative`; `marketing manager`; `research analyst`",
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "include_similar_titles",
            "in": "query",
            "required": false,
            "description": "This parameter determines whether people with job titles similar to the titles you define in the `person_titles[]` parameter are returned in the response. <br><br>Set this parameter to `false` when using `person_titles[]` to return only strict matches for job titles.",
            "schema": {
              "type": "boolean",
              "example": "true",
              "default": ""
            }
          },
          {
            "name": "q_keywords",
            "in": "query",
            "required": false,
            "description": "A string of words over which we want to filter the results.",
            "schema": {
              "type": "string",
              "default": ""
            }
          },
          {
            "name": "person_locations[]",
            "in": "query",
            "description": "The location where people live. You can search across cities, US states, and countries. <br><br>To find people based on the headquarters locations of their current employer, use the `organization_locations` parameter. <br><br>Examples: `california`; `ireland`; `chicago`",
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "person_seniorities[]",
            "in": "query",
            "required": false,
            "description": "The job seniority that people hold within their current employer. This enables you to find people that currently hold positions at certain reporting levels, such as Director level or senior IC level. <br><br>For a person to be included in search results, they only need to match 1 of the seniorities you add. Adding more seniorities expands your search results. <br><br> Searches only return results based on their current job title, so searching for Director-level employees only returns people that currently hold a Director-level title. If someone was previously a Director, but is currently a VP, they would not be included in your search results. <br><br>Use this parameter in combination with the `person_titles[]` parameter to find people based on specific job functions and seniority levels. <br><br>The following options can be used for this parameter: <br><ul><li><code>owner</code></li><li><code>founder</code></li><li><code>c_suite</code></li><li><code>partner</code></li><li><code>vp</code></li><li><code>head</code></li><li><code>director</code></li><li><code>manager</code></li><li><code>senior</code></li><li><code>entry</code></li><li><code>intern</code></li></ul>",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "organization_locations[]",
            "in": "query",
            "description": "The location of the company headquarters for a person's current employer. You can search across cities, US states, and countries. <br><br>If a company has several office locations, results are still based on the headquarters location. For example, if you search `chicago` but a company's HQ location is in `boston`, people that work for the Boston-based company will not appear in your results, even if they match other \\parameters. <br><br>To find people based on their personal location, use the `person_locations` parameter. <br><br>Examples: `texas`; `tokyo`; `spain`",
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "q_organization_domains_list[]",
            "in": "query",
            "required": false,
            "description": "The domain name for the person's employer. This can be the current employer or a previous employer. Do not include `www.`, the `@` symbol, or similar. <br><br>This parameter accepts up to 1,000 domains in a single request. <br><br>Examples: `apollo.io`; `microsoft.com`",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "contact_email_status[]",
            "in": "query",
            "description": "The email statuses for the people you want to find. You can add multiple statuses to expand your search. <br><br>The statuses you can search include:  <ul> <li> <code>verified</code> </li> <li> <code>unverified</code> </li> <li> <code>likely to engage</code> </li> <li> <code>unavailable</code> </li>  </ul>",
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "organization_ids[]",
            "in": "query",
            "description": "The Apollo IDs for the companies (employers) you want to include in your search results. Each company in the Apollo database is assigned a unique ID. <br><br>To find IDs, call the <a href=\"https://docs.apollo.io/reference/organization-search\" target=\"_blank\">Organization Search endpoint</a> and identify the values for `organization_id`.  <br><br>Example: `5e66b6381e05b4008c8331b8`",
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "organization_num_employees_ranges[]",
            "in": "query",
            "description": "The number range of employees working for the person's current company. This enables you to find people based on the headcount of their employer. You can add multiple ranges to expand your search results. <br><br>Each range you add needs to be a string, with the upper and lower numbers of the range separated only by a comma. <br><br>Examples: `1,10`; `250,500`; `10000,20000`",
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "revenue_range[min]",
            "in": "query",
            "required": false,
            "description": "The minimum revenue the person's current employer generates. Use this parameter in combination with `revenue_range[max]` to set a revenue range. <br><br>Do not enter currency symbols, commas, or decimal points in the figure. <br><br>Examples: `500000`; `1500000`",
            "schema": {
              "type": "integer",
              "default": ""
            }
          },
          {
            "name": "revenue_range[max]",
            "in": "query",
            "required": false,
            "description": "The maximum revenue the person's current employer generates. Use this parameter in combination with `revenue_range[min]` to set a revenue range. <br><br>Do not enter currency symbols, commas, or decimal points in the figure. <br><br>Examples: `500000`; `1500000`",
            "schema": {
              "type": "integer",
              "default": ""
            }
          },
          {
            "name": "currently_using_all_of_technology_uids[]",
            "in": "query",
            "required": false,
            "description": "Find people based on all of the technologies their current employer uses. Apollo supports filtering by 1,500+ technologies. <br><br>Apollo calculates technologies data from multiple sources. This data is updated regularly. Check out the full list of supported technologies by <a href=\"https://api.apollo.io/v1/auth/supported_technologies_csv\" target=\"_blank\">downloading this CSV file</a>. <br><br>Use underscores (`_`) to replace spaces and periods for the technologies listed in the CSV file. <br><br>Examples: `salesforce`; `google_analytics`; `wordpress_org`",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "currently_using_any_of_technology_uids[]",
            "in": "query",
            "required": false,
            "description": "Find people based on any of the technologies their current employer uses. Apollo supports filtering by 1,500+ technologies. <br><br>Apollo calculates technologies data from multiple sources. This data is updated regularly. Check out the full list of supported technologies by <a href=\"https://api.apollo.io/v1/auth/supported_technologies_csv\" target=\"_blank\">downloading this CSV file</a>. <br><br>Use underscores (`_`) to replace spaces and periods for the technologies listed in the CSV file. <br><br>Examples: `salesforce`; `google_analytics`; `wordpress_org`",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "currently_not_using_any_of_technology_uids[]",
            "in": "query",
            "required": false,
            "description": "Exclude people from your search based on any of the technologies their current employer uses. Apollo supports filtering by 1,500+ technologies. <br><br>Apollo calculates technologies data from multiple sources. This data is updated regularly. Check out the full list of supported technologies by <a href=\"https://api.apollo.io/v1/auth/supported_technologies_csv\" target=\"_blank\">downloading this CSV file</a>. <br><br>Use underscores (`_`) to replace spaces and periods for the technologies listed in the CSV file. <br><br>Examples: `salesforce`; `google_analytics`; `wordpress_org`",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "q_organization_job_titles[]",
            "in": "query",
            "required": false,
            "description": "The job titles that are listed in active job postings at the person's current employer. <br><br>Examples: `sales manager`; `research analyst`",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "organization_job_locations[]",
            "in": "query",
            "required": false,
            "description": "The locations of the jobs being actively recruited by the person's employer. <br><br>Examples: `atlanta`; `japan`",
            "schema": {
              "type": "array",
              "default": "",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "organization_num_jobs_range[min]",
            "in": "query",
            "required": false,
            "description": "The minimum number of job postings active at the person's current empployer. Use this parameter in combination with `organization_num_jobs_range[max]` to set a job postings range. <br><br>Examples: `50`; `500`",
            "schema": {
              "type": "integer",
              "default": ""
            }
          },
          {
            "name": "organization_num_jobs_range[max]",
            "in": "query",
            "required": false,
            "description": "The maximum number of job postings active at the person's current empployer. Use this parameter in combination with `organization_num_jobs_range[min]` to set a job postings range. <br><br>Examples: `50`; `500`",
            "schema": {
              "type": "integer",
              "default": ""
            }
          },
          {
            "name": "organization_job_posted_at_range[min]",
            "in": "query",
            "required": false,
            "description": "The earliest date when jobs were posted by the person's current employer. Use this parameter in combination with `organization_job_posted_at_range[max]` to set a date range for when jobs posted. <br><br>Example: `2025-07-25`",
            "schema": {
              "type": "string",
              "format": "date",
              "default": ""
            }
          },
          {
            "name": "organization_job_posted_at_range[max]",
            "in": "query",
            "required": false,
            "description": "The latest date when jobs were posted by the person's current employer. Use this parameter in combination with `organization_job_posted_at_range[min]` to set a date range for when jobs posted. <br><br>Example: `2025-09-25`",
            "schema": {
              "type": "string",
              "format": "date",
              "default": ""
            }
          },
          {
            "name": "page",
            "in": "query",
            "description": "The page number of the Apollo data that you want to retrieve. <br><br>Use this parameter in combination with the `per_page` parameter to make search results for navigable and improve the performance of the endpoint. <br><br>Example: `4`",
            "schema": {
              "type": "integer",
              "format": "int32"
            }
          },
          {
            "name": "per_page",
            "in": "query",
            "required": false,
            "description": "The number of search results that should be returned for each page. Limiting the number of results per page improves the endpoint's performance. <br><br>Use the `page` parameter to search the different pages of data. <br><br>Example: `10`",
            "schema": {
              "type": "integer",
              "format": "int32",
              "default": ""
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
                      "total_entries": 232764882,
                      "people": [
                        {
                          "id": "67bdafd0c3a4c50001bbd7c2",
                          "first_name": "Andrew",
                          "last_name_obfuscated": "Hu***n",
                          "title": "Professor and Neuroscientist at Stanford & Host",
                          "last_refreshed_at": "2025-11-04T23:20:32.690+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Scicomm Media",
                            "has_industry": true,
                            "has_phone": false,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": false,
                            "has_revenue": false,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "6775057df8360a0001a6852c",
                          "first_name": "Jon",
                          "last_name_obfuscated": "St***g",
                          "title": "Managing Director",
                          "last_refreshed_at": "2025-11-05T15:56:08.901+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Lazard",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": true,
                            "has_revenue": true,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "637dd5071c576c0001ccbff4",
                          "first_name": "Lorena",
                          "last_name_obfuscated": "Ac***a",
                          "title": "Director of Operations",
                          "last_refreshed_at": "2025-11-03T10:01:50.493+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Be Busy Being Awesome",
                            "has_industry": true,
                            "has_phone": false,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": false,
                            "has_revenue": false,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "6282fecea784280001553642",
                          "first_name": "Linda",
                          "last_name_obfuscated": "Ch***n",
                          "title": "Sales Manager",
                          "last_refreshed_at": "2025-09-29T11:53:35.791+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "MCU Technology Co., Ltd",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": false,
                            "has_state": false,
                            "has_country": false,
                            "has_zip_code": false,
                            "has_revenue": false,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "66ed23831ae8c9000186c75b",
                          "first_name": "Nicholas",
                          "last_name_obfuscated": "Th***n",
                          "title": "Chief Executive Officer",
                          "last_refreshed_at": "2025-11-07T17:08:51.086+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "The Atlantic",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": true,
                            "has_revenue": true,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "6728af09afa3de00011a722e",
                          "first_name": "Ron",
                          "last_name_obfuscated": "Kr***i",
                          "title": null,
                          "last_refreshed_at": "2025-11-05T23:23:13.047+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Stifel Financial Corp.",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": true,
                            "has_revenue": true,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "54a2b92a74686935beffa837",
                          "first_name": "Rita",
                          "last_name_obfuscated": "Ki***g",
                          "title": "Founder",
                          "last_refreshed_at": "2025-11-07T07:13:05.197+00:00",
                          "has_email": true,
                          "has_city": false,
                          "has_state": false,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Power Pairs",
                            "has_industry": true,
                            "has_phone": false,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": false,
                            "has_revenue": false,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "63be196afa109b000139ace7",
                          "first_name": "Austin",
                          "last_name_obfuscated": "Be***k",
                          "title": "Founder",
                          "last_refreshed_at": "2025-11-02T05:22:18.569+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Cultivated Culture",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": false,
                            "has_revenue": false,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "5e8a7a4dfd23700001a64dfb",
                          "first_name": "Elina",
                          "last_name_obfuscated": "Ga***a",
                          "title": "SVP, Head of Global Operations",
                          "last_refreshed_at": "2025-11-05T13:50:24.941+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Twelve",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": true,
                            "has_revenue": true,
                            "has_employee_count": true
                          }
                        },
                        {
                          "id": "66ec0684cd386c0001b15096",
                          "first_name": "Matt",
                          "last_name_obfuscated": "Gr***y",
                          "title": "Founder & CEO",
                          "last_refreshed_at": "2025-11-06T15:08:56.795+00:00",
                          "has_email": true,
                          "has_city": true,
                          "has_state": true,
                          "has_country": true,
                          "has_direct_phone": "Yes",
                          "organization": {
                            "name": "Founder OS",
                            "has_industry": true,
                            "has_phone": true,
                            "has_city": true,
                            "has_state": true,
                            "has_country": true,
                            "has_zip_code": true,
                            "has_revenue": false,
                            "has_employee_count": true
                          }
                        }
                      ]
                    }
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "total_entries": {
                      "type": "integer",
                      "description": "The total number of people that match your search criteria.",
                      "example": 2
                    },
                    "people": {
                      "type": "array",
                      "description": "An array of people that match your search criteria.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "description": "The Apollo ID for the person.",
                            "example": "587cf802f65125cad923a266"
                          },
                          "first_name": {
                            "type": "string",
                            "description": "The first name of the person.",
                            "example": "John"
                          },
                          "last_name_obfuscated": {
                            "type": "string",
                            "description": "The last name of the person with the middle characters obfuscated for privacy. The format shows the first 2 characters, followed by asterisks, and then the last character.",
                            "example": "Do***e"
                          },
                          "title": {
                            "type": [
                              "string",
                              "null"
                            ],
                            "description": "The job title of the person. This field may be null if the person's title is not available.",
                            "example": "VP of Sales"
                          },
                          "last_refreshed_at": {
                            "type": "string",
                            "format": "date-time",
                            "description": "The date and time when the person's data was last refreshed in Apollo's database.",
                            "example": "2024-01-15T10:30:00.000Z"
                          },
                          "has_email": {
                            "type": "boolean",
                            "description": "Indicates whether Apollo has a verified email address for this person.",
                            "example": true
                          },
                          "has_city": {
                            "type": "boolean",
                            "description": "Indicates whether Apollo has city location data for this person.",
                            "example": true
                          },
                          "has_state": {
                            "type": "boolean",
                            "description": "Indicates whether Apollo has state location data for this person.",
                            "example": true
                          },
                          "has_country": {
                            "type": "boolean",
                            "description": "Indicates whether Apollo has country location data for this person.",
                            "example": true
                          },
                          "has_direct_phone": {
                            "type": "string",
                            "description": "Indicates whether Apollo has direct phone number data for this person. Returns `Yes` if available, or `Maybe: please request direct dial via people/bulk_match` if uncertain.",
                            "example": "Yes"
                          },
                          "organization": {
                            "type": "object",
                            "description": "Information about the person's current employer organization.",
                            "properties": {
                              "name": {
                                "type": "string",
                                "description": "The name of the organization.",
                                "example": "Apollo.io"
                              },
                              "has_industry": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has industry classification data for this organization.",
                                "example": true
                              },
                              "has_phone": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has phone number data for this organization.",
                                "example": true
                              },
                              "has_city": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has city location data for the organization's headquarters.",
                                "example": true
                              },
                              "has_state": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has state location data for the organization's headquarters.",
                                "example": true
                              },
                              "has_country": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has country location data for the organization's headquarters.",
                                "example": true
                              },
                              "has_zip_code": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has postal/zip code data for the organization's headquarters.",
                                "example": true
                              },
                              "has_revenue": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has revenue data for this organization.",
                                "example": true
                              },
                              "has_employee_count": {
                                "type": "boolean",
                                "description": "Indicates whether Apollo has employee count data for this organization.",
                                "example": true
                              }
                            }
                          }
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
          "403": {
            "description": "403",
            "content": {
              "application/json": {
                "examples": {
                  "Need master API key": {
                    "value": {
                      "error": "api/v1/mixed_people/api_search is not accessible with this api_key",
                      "error_code": "API_INACCESSIBLE"
                    }
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string",
                      "example": "api/v1/mixed_people/api_search is not accessible with this api_key"
                    },
                    "error_code": {
                      "type": "string",
                      "example": "API_INACCESSIBLE"
                    }
                  }
                }
              }
            }
          },
          "422": {
            "description": "422",
            "content": {
              "application/json": {
                "examples": {
                  "Validation error": {
                    "value": {
                      "error": "Invalid parameters"
                    }
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string",
                      "example": "Invalid search parameters provided."
                    }
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
                      "message": "{\n    \"message\": \"The maximum number of api calls allowed for api/v1/mixed_people/api_search is 600 times per hour. Please upgrade your plan from https://app.apollo.io/#/settings/plans/upgrade.\"\n}"
                    }
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "message": {
                      "type": "string",
                      "example": "The maximum number of api calls allowed for api/v1/mixed_people/api_search is 600 times per hour. Please upgrade your plan from https://app.apollo.io/#/settings/plans/upgrade."
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