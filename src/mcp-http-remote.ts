import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ConvertResponse, ArtifactEnvelope } from "./contracts.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const converterBaseUrl = (process.env.CONVERTER_BASE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:4200").replace(/\/$/, "");
const artifactTtlMs = 10 * 60 * 1000;
const artifacts = new Map<string, ArtifactEnvelope>();
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

function createSessionServer() {
  const server = new McpServer({ name: "protobuf-remote-mcp", version: "1.0.0" });
  server.registerTool(
    "convert-protobuf",
    {
      title: "Convert Protobuf contract",
      description: "Convert an authorized Protobuf URL and return an artifact ID. This remote server does not write to the developer's local filesystem.",
      inputSchema: {
        protoUrl: z.string().url().describe("Authorized Protobuf contract URL."),
        contractVersion: z.string().optional().describe("Optional contract revision for traceability."),
      },
    },
    async ({ protoUrl, contractVersion }) => {
      const response = await fetch(`${converterBaseUrl}/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protoUrl, contractVersion }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json() as ConvertResponse | { error?: string; message?: string };
      if (!response.ok || !("success" in body) || !body.success) {
        throw new Error(`Converter service failed: ${"message" in body ? body.message : "unknown error"}`);
      }

      const artifactId = randomUUID();
      const expiresAt = new Date(Date.now() + artifactTtlMs).toISOString();
      artifacts.set(artifactId, { ...body, artifactId, expiresAt });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            artifactId,
            artifactUrl: `${publicBaseUrl}/artifacts/${artifactId}`,
            sourceName: body.sourceName,
            contractVersion: body.contractVersion,
            sha256: body.sha256,
            generatedFiles: body.files.map((file) => file.path),
            expiresAt,
            nextStep: "Use a local workspace bridge/client-side file tool to download and apply this artifact. This remote MCP process cannot directly write into your laptop's workspace.",
          }, null, 2),
        }],
      };
    }
  );
  return server;
}

// Demo artifact endpoint. In production, protect this with auth, short-lived signed URLs,
// size limits, audit logs, and a durable artifact store if multiple server instances are used.
app.get("/artifacts/:artifactId", (req, res) => {
  const artifact = artifacts.get(req.params.artifactId);
  if (!artifact || Date.now() > Date.parse(artifact.expiresAt)) {
    artifacts.delete(req.params.artifactId);
    res.status(404).json({ error: "Artifact not found or expired." });
    return;
  }
  res.json(artifact);
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    let entry = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !entry) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null });
      return;
    }

    if (!entry && isInitializeRequest(req.body)) {
      const server = createSessionServer();
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { transport, server });
          console.error(`MCP session initialized: ${newSessionId}`);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        void server.close();
      };
      await server.connect(transport);
      entry = { transport, server };
    }

    if (!entry) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Initialize MCP session first" }, id: null });
      return;
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP POST error:", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) {
    res.status(400).send("Missing or invalid MCP session");
    return;
  }
  try {
    await entry.transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP GET error:", error);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) {
    res.status(404).send("Session not found");
    return;
  }
  try {
    await entry.transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP DELETE error:", error);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  }
});

const port = Number(process.env.MCP_HTTP_PORT ?? 4200);
app.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.error(`Remote Streamable HTTP MCP listening on http://127.0.0.1:${port}/mcp`);
  console.error(`Artifact endpoint: ${publicBaseUrl}/artifacts/:artifactId`);
});
