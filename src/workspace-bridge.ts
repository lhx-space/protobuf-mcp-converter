import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ArtifactEnvelope } from "./contracts.js";
import { writeGeneratedFiles } from "./workspace-writer.js";

const server = new McpServer({ name: "protobuf-workspace-bridge", version: "1.0.0" });
const artifactBaseUrl = (process.env.ARTIFACT_SERVER_BASE_URL ?? "http://127.0.0.1:4200").replace(/\/$/, "");

server.registerTool(
  "apply-conversion-artifact",
  {
    title: "Apply generated artifact to local workspace",
    description: "Download an artifact created by the remote Protobuf MCP and safely write its files into the local workspace. Does not commit or push.",
    inputSchema: {
      artifactId: z.string().uuid().describe("Artifact ID returned by the remote convert-protobuf tool."),
      outputDir: z.string().default("src/generated/protobuf").describe("Relative output directory under WORKSPACE_ROOT."),
    },
  },
  async ({ artifactId, outputDir }) => {
    const response = await fetch(`${artifactBaseUrl}/artifacts/${encodeURIComponent(artifactId)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Artifact download failed with HTTP ${response.status}.`);
    const artifact = await response.json() as ArtifactEnvelope;
    if (artifact.artifactId !== artifactId || Date.now() > Date.parse(artifact.expiresAt)) {
      throw new Error("Artifact ID mismatch or artifact expired.");
    }
    const written = await writeGeneratedFiles(outputDir, artifact.files);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          artifactId,
          sourceName: artifact.sourceName,
          contractVersion: artifact.contractVersion,
          sha256: artifact.sha256,
          writtenFiles: written,
          warnings: artifact.warnings,
          nextStep: "Review git diff, run tests, and commit manually if the changes are correct.",
        }, null, 2),
      }],
    };
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("Workspace bridge connected over stdio; it writes only below WORKSPACE_ROOT.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
