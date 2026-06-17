import request from 'supertest';
import { app, impl, parseUpstreamBody } from './index';

const CLIENTS = { injex: 'injex-key', pathfinder: 'pf-key' };

beforeEach(() => {
  process.env.MCP_AUTH_TOKEN = 'test-token';
  process.env.PROMPTWATCH_CLIENTS_JSON = JSON.stringify(CLIENTS);
});

afterEach(() => {
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.PROMPTWATCH_CLIENTS_JSON;
  jest.restoreAllMocks();
});

const AUTH = { Authorization: 'Bearer test-token' };

function mockUpstream(returnValue: unknown) {
  return jest.spyOn(impl, 'postUpstream').mockResolvedValue(returnValue);
}

describe('Bearer guard', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong token', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer wrong')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });

  it('passes through with correct token', async () => {
    mockUpstream({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
  });
});

describe('tools/list injection', () => {
  it('appends client param to every tool inputSchema', async () => {
    mockUpstream({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'my_tool',
            inputSchema: { type: 'object', properties: { foo: { type: 'string' } }, required: [] },
          },
        ],
      },
    });

    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    const tool = res.body.result.tools[0];
    expect(tool.inputSchema.properties).toHaveProperty('client');
    expect(tool.inputSchema.properties.client.enum).toEqual(Object.keys(CLIENTS));
  });

  it('makes client a required field', async () => {
    mockUpstream({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'my_tool', inputSchema: { type: 'object', properties: {}, required: [] } },
        ],
      },
    });

    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    const tool = res.body.result.tools[0];
    expect(tool.inputSchema.required).toContain('client');
  });
});

describe('tools/call routing', () => {
  it('returns error in JSON-RPC body when client arg is missing', async () => {
    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'my_tool', arguments: { foo: 'bar' } },
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error');
  });

  it('returns error in JSON-RPC body when client slug is unknown', async () => {
    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'my_tool', arguments: { client: 'unknown', foo: 'bar' } },
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error');
  });

  it('strips client from forwarded args', async () => {
    const spy = mockUpstream({ jsonrpc: '2.0', id: 4, result: {} });

    await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'my_tool', arguments: { client: 'injex', foo: 'bar' } },
      });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, forwardedBody] = spy.mock.calls[0] as [
      string,
      { params: { arguments: Record<string, unknown> } },
    ];
    expect(forwardedBody.params.arguments).not.toHaveProperty('client');
    expect(forwardedBody.params.arguments).toHaveProperty('foo', 'bar');
  });

  it('forwards with correct upstream Bearer token', async () => {
    const spy = mockUpstream({ jsonrpc: '2.0', id: 5, result: {} });

    await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'my_tool', arguments: { client: 'injex', foo: 'bar' } },
      });

    expect(spy).toHaveBeenCalledTimes(1);
    const [token] = spy.mock.calls[0] as [string, unknown];
    expect(token).toBe('injex-key');
  });
});

// Regression coverage for the 2026-06-16 crash: the deep MCP healthcheck
// probe sends `initialize` then `notifications/initialized` (a JSON-RPC
// notification — no `id`, no response body expected). That request falls
// through to the passthrough branch and upstream legitimately answers with
// an empty body. The old parser treated any non-JSON, non-SSE body as an
// error and rejected, which — awaited with no try/catch in the route
// handler — became an unhandled promise rejection and crashed the whole
// Node process (Node 20 default: --unhandled-rejections=throw).
describe('parseUpstreamBody', () => {
  it('treats an empty body as a valid no-content result, not an error', () => {
    expect(parseUpstreamBody('')).toBeUndefined();
    expect(parseUpstreamBody('   \n  ')).toBeUndefined();
  });

  it('still parses plain JSON bodies', () => {
    expect(parseUpstreamBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });

  it('still parses SSE-framed bodies', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseUpstreamBody(sse)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('still rejects genuinely unparseable non-empty bodies', () => {
    expect(() => parseUpstreamBody('<html>502 Bad Gateway</html>')).toThrow(
      /Unexpected upstream response/,
    );
  });
});

describe('passthrough for notification-style methods (no id)', () => {
  it('does not crash and responds when upstream returns an empty body', async () => {
    mockUpstream(undefined);

    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // The exact body doesn't matter — what matters is the process didn't
    // crash and the request got a response at all.
    expect(res.status).toBeLessThan(500);
  });
});

describe('upstream error resilience', () => {
  it('returns a JSON-RPC error response instead of crashing when postUpstream rejects', async () => {
    jest.spyOn(impl, 'postUpstream').mockRejectedValue(new Error('Unexpected upstream response: '));

    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .send({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });

    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.message).toMatch(/Unexpected upstream response/);
  });
});
