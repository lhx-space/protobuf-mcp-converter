import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ConvertResponse } from "./contracts.js";
import { writeGeneratedFiles } from "./workspace-writer.js";

const server = new McpServer({ name: "protobuf-local-workspace", version: "1.0.0" });
const converterBaseUrl = (process.env.CONVERTER_BASE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");

server.registerTool(
  "convert-protobuf-to-workspace",
  {
    title: "Convert Protobuf and write into local workspace",
    description: "Fetch an allowed Protobuf contract, call the converter service, and write generated TypeScript into the configured local workspace. Does not run git commit/push.",
    inputSchema: {
      protoUrl: z.string().url().describe("Authorized Protobuf contract URL; host must be allow-listed by converter service."),
      outputDir: z.string().default("src/generated/protobuf").describe("Relative directory under WORKSPACE_ROOT; absolute paths are rejected."),
      contractVersion: z.string().optional().describe("Optional contract revision for traceability."),
    },
  },
  async ({ protoUrl, outputDir, contractVersion }) => {
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

    const written = await writeGeneratedFiles(outputDir, body.files);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          sourceName: body.sourceName,
          contractVersion: body.contractVersion,
          sha256: body.sha256,
          writtenFiles: written,
          warnings: body.warnings,
          nextStep: "Review git diff, run tests, and commit manually if the changes are correct.",
        }, null, 2),
      }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP stdio reserves stdout for protocol messages: logs go to stderr.
  console.error("Local workspace MCP server connected over stdio.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
