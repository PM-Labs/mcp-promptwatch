import express, { Request, Response, NextFunction } from 'express';
import https from 'https';
import fs from 'fs';
import { timingSafeEqual } from 'crypto';

const app = express();
app.use(express.json());

const UPSTREAM = 'https://server.promptwatch.com/mcp';

function loadClients(): Record<string, string> {
  if (process.env.PROMPTWATCH_CLIENTS_JSON) {
    return JSON.parse(process.env.PROMPTWATCH_CLIENTS_JSON);
  }
  const path =
    process.env.PROMPTWATCH_CLIENTS_FILE ||
    '/opt/pmin-mcpinfrastructure/env/promptwatch-clients.json';
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

// Module-level cache for file-based clients (populated on first use or SIGHUP).
// When PROMPTWATCH_CLIENTS_JSON is set (e.g. tests, container env), loadClients()
// reads it directly from the env var and is cheap to call per-request.
let _cachedClients: Record<string, string> | null = null;

function getClients(): Record<string, string> {
  if (process.env.PROMPTWATCH_CLIENTS_JSON) {
    return loadClients(); // env-var path: always fresh, zero I/O
  }
  if (!_cachedClients) {
    _cachedClients = loadClients();
  }
  return _cachedClients;
}

// Hot-reload on SIGHUP (e.g. after editing promptwatch-clients.json on droplet)
process.on('SIGHUP', () => {
  try {
    _cachedClients = loadClients();
    console.log('promptwatch-clients reloaded:', Object.keys(_cachedClients).join(', '));
  } catch (err) {
    console.error('Failed to reload clients:', err);
  }
});

// Parses a raw upstream response body into the value postUpstream resolves
// with. Exported (via the `impl` indirection isn't needed here — this is a
// pure function) so the empty-body / notification case is directly testable
// without spinning up a real HTTPS connection.
//
// An empty body is a VALID response, not an error: per JSON-RPC 2.0, a
// notification (a request with no `id`, e.g. `notifications/initialized`)
// gets no response payload at all. Treating that as "unexpected" caused
// _postUpstream to reject — see parseUpstreamBody empty-body test for the
// regression this guards against.
export function parseUpstreamBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  // Upstream may return plain JSON or SSE (event: message\ndata: {...}\n\n)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  // Parse SSE: extract last `data:` line with a JSON payload
  const dataLine = trimmed.split('\n').reverse().find(l => l.startsWith('data:'));
  if (dataLine) {
    return JSON.parse(dataLine.slice(5).trim());
  }
  throw new Error(`Unexpected upstream response: ${trimmed.slice(0, 200)}`);
}

function _postUpstream(token: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(UPSTREAM);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(parseUpstreamBody(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Indirection object — tests replace postUpstream here to intercept calls
export const impl = {
  postUpstream: _postUpstream,
};

// Bearer guard middleware
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.MCP_AUTH_TOKEN;
  const header = req.headers.authorization;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post(
  '/mcp',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handleMcp(req, res);
    } catch (err) {
      // Defense in depth: Express does not catch rejections thrown by async
      // route handlers, so any unhandled error here (a future upstream
      // hiccup, malformed response, network failure, etc.) would otherwise
      // become an unhandled promise rejection — which crashes the entire
      // Node process under Node's default `--unhandled-rejections=throw`,
      // taking the proxy down for every connected client. Surfacing it as a
      // JSON-RPC error response keeps a single bad upstream call from
      // becoming a full outage. See parseUpstreamBody for the specific
      // root-cause bug (empty-body upstream responses) this also guards.
      console.error('mcp route error:', err);
      if (!res.headersSent) {
        res.status(502).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? null,
          error: {
            code: -32000,
            message: `Upstream error: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    }
  },
);

async function handleMcp(req: Request, res: Response): Promise<void> {
  const body = req.body;
  const clients = getClients();
  const clientEntries = Object.entries(clients);

  if (clientEntries.length === 0) {
    res.status(500).json({ error: 'No clients configured' });
    return;
  }

  const [, firstToken] = clientEntries[0];

  if (body.method === 'tools/list') {
    const data = (await impl.postUpstream(firstToken, body)) as {
      result?: { tools?: Array<{ inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] } }> };
    };

    if (data?.result?.tools) {
      const clientSlugs = Object.keys(clients);
      data.result.tools = data.result.tools.map((tool) => {
        const schema = tool.inputSchema || { type: 'object', properties: {} };
        schema.properties = schema.properties || {};
        schema.properties['client'] = {
          type: 'string',
          enum: clientSlugs,
          description: 'Client slug to route this request to',
        };
        schema.required = [...(schema.required || []), 'client'];
        tool.inputSchema = schema;
        return tool;
      });
    }

    res.json(data);
    return;
  }

  if (body.method === 'tools/call') {
    const args: Record<string, unknown> = body.params?.arguments || {};
    const clientSlug = args['client'] as string | undefined;

    if (!clientSlug) {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32602,
          message:
            'Missing required argument: client. Valid clients: ' +
            Object.keys(clients).join(', '),
        },
      });
      return;
    }

    const upstreamToken = clients[clientSlug];
    if (!upstreamToken) {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32602,
          message: `Unknown client: ${clientSlug}. Valid clients: ${Object.keys(clients).join(', ')}`,
        },
      });
      return;
    }

    const forwardedArgs = { ...args };
    delete forwardedArgs['client'];

    const forwardedBody = {
      ...body,
      params: { ...body.params, arguments: forwardedArgs },
    };

    const data = await impl.postUpstream(upstreamToken, forwardedBody);
    res.json(data);
    return;
  }

  // Passthrough for other methods
  const data = await impl.postUpstream(firstToken, body);
  res.json(data);
}

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => console.log(`mcp-promptwatch listening on :${PORT}`));
}

export { app };
