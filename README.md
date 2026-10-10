# Protobuf + MCP end-to-end demo

This project shows three distinct locations/roles:

1. **Protobuf converter HTTP service** (`src/converter-server.ts`, port 4100): fetches an allow-listed `.proto` URL and generates a small TypeScript declaration file.
2. **Local MCP wrapper** (`src/mcp-local.ts`, stdio): runs on the developer machine, calls the converter HTTP API, and writes generated files under `WORKSPACE_ROOT`.
3. **Remote Streamable HTTP MCP** (`src/mcp-http-remote.ts`, port 4200) plus **local workspace bridge** (`src/workspace-bridge.ts`, stdio): remote MCP creates a short-lived artifact; the local bridge downloads it and writes files into the developer workspace.

The converter in this demo is intentionally educational. It supports self-contained `.proto` files with scalar fields, messages, enums, repeated fields, and map fields. It does **not** replace `protoc` or a production code generator; imports, services/client stubs, `oneof`, custom options, and runtime codecs are not generated. Use your organization's approved generator for real projects.

## Requirements

- Node.js 20+ (Node 18.18+ may also work)
- npm

## Install

```bash
npm install
npm run typecheck
```

## Option A: local MCP wrapper (one tool call writes locally)

Terminal 1:

```bash
npm run dev:converter
```

Register `src/mcp-local.ts` as a **stdio/local MCP server** in your IDE (see `config/mcp.local.example.json`). The IDE launches this process; set `WORKSPACE_ROOT` to the frontend repository. Do not run it in a separate terminal and expect an MCP client to attach to its stdin/stdout. If you use MCP Inspector, configure it to launch the stdio command itself.

The converter service may be remote in a real deployment; the MCP wrapper remains local to write to the workspace.

In MCP Inspector/CodeBuddy, call `convert-protobuf-to-workspace` with:

```json
{
  "protoUrl": "http://127.0.0.1:4100/contracts/order.proto",
  "outputDir": "src/generated/protobuf",
  "contractVersion": "demo-v1"
}
```

The converter URL points to the demo fixture endpoint. If you use a real internal contract URL, add only the approved hostname(s) to `PROTO_ALLOWED_HOSTS` on the converter service.

## Option B: remote Streamable HTTP MCP + local workspace bridge

Terminal 1:

```bash
npm run dev:converter
```

Terminal 2:

```bash
npm run dev:mcp:http
```

The MCP endpoint is `http://127.0.0.1:4200/mcp`. Register it as a **Streamable HTTP MCP server**. The remote Tool `convert-protobuf` returns an `artifactId`; it does not write files to the developer's machine.

Register `src/workspace-bridge.ts` as a **stdio/local MCP server** in your IDE using `config/mcp.remote-with-local-bridge.example.json`. The IDE launches the bridge process with `WORKSPACE_ROOT` set to the frontend repository.

Then perform two tool calls:

1. Call the remote `convert-protobuf` tool with `protoUrl` and optionally `contractVersion`.
2. Take the returned `artifactId` and call local `apply-conversion-artifact` with `artifactId` and `outputDir`.

The artifact endpoint is a demo-only HTTP endpoint. In production, protect it with authentication/authorization, short-lived signed URLs or equivalent access control, audit logs, size limits, and a shared/durable artifact store if the service is horizontally scaled.

## Test converter manually

```bash
curl -s http://127.0.0.1:4100/healthz
curl -s -X POST http://127.0.0.1:4100/convert \
  -H 'content-type: application/json' \
  -d '{"protoUrl":"http://127.0.0.1:4100/contracts/order.proto","contractVersion":"demo-v1"}'
```

## Safety notes

- The demo binds services to `127.0.0.1` by default; set `HOST=0.0.0.0` or a private interface address only when needed for remote access, and place it behind authentication/TLS/reverse-proxy controls.
- `PROTO_ALLOWED_HOSTS` is an allow-list, not general URL fetching. Do not set it to `*`.
- Do not pass credentials in contract URLs.
- The workspace writer requires a relative `outputDir`, confines writes to `WORKSPACE_ROOT`, rejects detected symlink path components, and atomically replaces files one by one (not as a multi-file transaction). It does not run `git add`, `commit`, or `push`.
- The remote artifact endpoint is unauthenticated in this local demonstration and must not be exposed publicly as-is.
- All generated files should be reviewed with `git diff` and validated with your normal typecheck/tests before commit.

## Which design does a Git Submodule hash change point to?

A changed submodule gitlink proves that the parent repository's local index/working tree is seeing a different submodule commit than the recorded pointer. It does **not** by itself prove whether the MCP server is local or remote. A remote MCP can return an artifact which a local IDE capability writes; a local stdio MCP can call a remote converter API. Inspect the MCP config and process/network/filesystem traces to distinguish them.
