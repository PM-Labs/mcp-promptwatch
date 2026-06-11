# mcp-promptwatch

Thin HTTP proxy that consolidates 5 per-client PromptWatch MCP entries into one multi-client MCP endpoint.

## What it does

Instead of registering one claude.ai MCP connector per PromptWatch client, this proxy:

1. Exposes a single MCP endpoint at `https://promptwatch.mcp.pathfindermarketing.com.au/mcp`
2. Injects a `client` enum parameter into every tool schema (`tools/list`) listing all configured client slugs
3. Strips the `client` param at call time (`tools/call`), looks up the per-client token, and forwards the request to the upstream PromptWatch server with the correct Bearer token

Upstream: `https://server.promptwatch.com/mcp`

## Config

Client slugs and tokens are loaded from one of two sources (first wins):

| Source | Format |
|---|---|
| `PROMPTWATCH_CLIENTS_JSON` env var | JSON object `{"slug": "token", ...}` |
| File at `PROMPTWATCH_CLIENTS_FILE` (default: `/opt/pmin-mcpinfrastructure/env/promptwatch-clients.json`) | Same JSON object |

The clients file on the droplet is the normal path -- env var override is for testing.

## Auth

Incoming requests must include `Authorization: Bearer <token>` where the token matches `MCP_AUTH_TOKEN` env var. This is the shared gateway token (not per-client).

## Hot-reload

To reload the client list without restarting the container:

```bash
kill -SIGHUP <pid>
# or from outside the container:
docker exec <container> kill -s HUP 1
```

SIGHUP re-reads the clients file/env var in place.

## Secrets (1Password)

All secrets are in the **Claude Code** vault under item `Claude_Remote_MCP - Promptwatch`:
- `MCP_AUTH_TOKEN` -- gateway Bearer token
- Per-client tokens (one field per slug)

## Tests

```bash
npm test   # Jest, 9 tests covering tools/list injection, tools/call routing, auth rejection, SIGHUP reload
```

## Deploy

```bash
# Push to origin
git push origin main

# SSH to droplet and rebuild
ssh mcp-server
cd /opt/pmin-mcpinfrastructure
git pull
docker compose up -d --build promptwatch
```

Container name in compose: `promptwatch`. Service URL after deploy: `https://promptwatch.mcp.pathfindermarketing.com.au/mcp`.

## Architecture notes

- `src/index.ts` -- entry point, HTTP server, SIGHUP handler
- `src/proxy.ts` -- MCP message handling: `tools/list` schema injection, `tools/call` routing
- `src/clients.ts` -- client config loader (env var + file, with hot-reload)
- No persistent state -- stateless per-request proxy
