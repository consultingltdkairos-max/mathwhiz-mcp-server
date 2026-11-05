'use strict';
// Mathwhiz MCP server (phase 1): streamable-HTTP MCP endpoint exposing three
// read-only tools for HighLevel Conversation AI. Zero runtime dependencies.
//
// Auth: every MCP request must carry `Authorization: Bearer <MCP_BEARER_TOKEN>`.
// Transport: POST /mcp with JSON-RPC 2.0 (initialize, ping, tools/list,
// tools/call). Stateless: each response is a plain JSON body, which the
// streamable-HTTP transport permits. GET /health is unauthenticated for the
// host's healthcheck and returns no data.

const http = require('http');
const crypto = require('crypto');
const { loadData } = require('./data');
const { TOOLS } = require('./tools');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TOKEN = process.env.MCP_BEARER_TOKEN || '';
const SERVER_INFO = { name: 'mathwhiz-mcp', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-03-26';

function tokenOk(req) {
  if (!TOKEN) return false;
  const header = req.headers.authorization || '';
  const expected = `Bearer ${TOKEN}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      };
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const started = Date.now();
      try {
        const data = await loadData();
        const result = tool.run(data, params.arguments || {});
        // Log shape only, never arguments: child phone numbers must not land in logs.
        console.log(`[mcp] tools/call ${name} ok in ${Date.now() - started}ms`);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        };
      } catch (err) {
        console.error(`[mcp] tools/call ${name} failed: ${err.message}`);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: 'lookup failed, please try again' }) }],
            isError: true,
          },
        };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: SERVER_INFO.name });
  }
  if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  if (!tokenOk(req)) return sendJson(res, 401, { error: 'unauthorized' });

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (Array.isArray(msg)) {
      // Batch: answer requests, skip notifications.
      const replies = [];
      for (const m of msg) {
        if (m && m.method && m.id !== undefined) replies.push(await handleRpc(m));
      }
      return sendJson(res, 200, replies);
    }
    if (msg && msg.method && msg.id === undefined) {
      // Notification (e.g. notifications/initialized): accept silently.
      return sendJson(res, 202, {});
    }
    if (!msg || !msg.method) return sendJson(res, 400, rpcError(null, -32600, 'Invalid request'));
    const reply = await handleRpc(msg);
    return sendJson(res, 200, reply);
  });
});

server.listen(PORT, () => {
  console.log(`[mcp] ${SERVER_INFO.name} v${SERVER_INFO.version} listening on :${PORT} (adapter: ${process.env.DATA_ADAPTER || 'supabase'})`);
  if (!TOKEN) console.error('[mcp] WARNING: MCP_BEARER_TOKEN is not set; all MCP requests will be rejected');
});
