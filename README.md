# Make MCP Server

MCP server for Make.com, supporting both stdio (local) and HTTP/SSE (remote) transports.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MAKE_API_KEY` | Yes | Make.com API key |
| `MAKE_TEAM_ID` | No | Default team ID |
| `MAKE_REGION` | No | API region (default: `eu1`) |
| `PORT` | No | HTTP port — omit to run in stdio mode |
| `MCP_ACCESS_TOKEN` | **Yes (HTTP mode)** | Bearer token for request authentication |

### `MCP_ACCESS_TOKEN`

When the server runs in HTTP mode (`PORT` is set), every request to `/sse` and `/message` must include the header:

```
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

If the token is missing or incorrect, the server returns `401 Unauthorized`.

The `/health` endpoint is exempt from authentication and can be used by platform health checks without credentials.

> **Note:** When running in stdio mode (`PORT` not set), authentication is not applied.

## Setup

```bash
cp .env.example .env
# Fill in your values in .env
npm install
npm run build
npm start
```
