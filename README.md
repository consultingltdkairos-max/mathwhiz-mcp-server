# Mathwhiz MCP server (phase 1)

Read-only MCP endpoint for HighLevel Conversation AI. Exposes exactly three
tools, all reads, no writes anywhere:

- `get_class_availability(grade)` — enrolled students and spaces left per
  class for the Monday/Wednesday and Tuesday/Thursday day pairs, counted live
  from platform enrolments (Active enrolment + Active student profile, the
  same counting as the placement fill rule). Spaces are reported against the
  platform's recorded capacity and against the internal cap of 30 per class.
- `get_child_status(guardian_phone)` — enrolment status for the children of
  the guardian whose own phone number is given (enrolled or not, grade, class
  days). Only that family's children are ever returned; an unknown number
  returns `{ "found": false }`. Finance-protected students are fenced out,
  matching the platform assistant API.
- `get_class_times(grade)` — settled class times (Grades 7/8: 6:30–7:30 PM;
  Grades 9–11: 6:30–8:00 PM) with the day pairs and class names read live
  from the platform.

## Transport and auth

Streamable-HTTP MCP at `POST /mcp` (JSON-RPC 2.0: `initialize`, `ping`,
`tools/list`, `tools/call`). Every MCP request requires
`Authorization: Bearer <MCP_BEARER_TOKEN>`. `GET /health` is unauthenticated
and returns no data.

## Environment

- `PORT` — set by the host.
- `MCP_BEARER_TOKEN` — the token HighLevel stores for the custom MCP connection.
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — platform data reads (PostgREST,
  service key, read-only usage).
- `DATA_ADAPTER` — `platform` (production: reads the platform app's
  /api/assistant/mcp-data endpoint), `supabase`, or `snapshot` (offline tests
  only). Platform mode needs `ASSISTANT_API_SECRET` and optionally
  `PLATFORM_BASE_URL` (default https://app.mathwhizacademy.com).

## Run

```
npm start
```

No dependencies to install. Node 18+.
