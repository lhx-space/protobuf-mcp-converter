import express from "express";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generateTypeScript } from "./protobuf-generator.js";
import type { ConvertResponse } from "./contracts.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../fixtures/order.proto");
const app = express();
app.use(express.json({ limit: "1mb" }));

const ConvertBody = z.object({
  protoUrl: z.string().url().optional(),
  protoText: z.string().min(1).max(1_000_000).optional(),
  contractVersion: z.string().max(200).optional(),
}).refine((value) => Boolean(value.protoUrl) !== Boolean(value.protoText), {
  message: "Provide exactly one of protoUrl or protoText.",
});

const defaultAllowedHosts = ["localhost", "127.0.0.1"];
const allowedHosts = new Set(
  (process.env.PROTO_ALLOWED_HOSTS ?? defaultAllowedHosts.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

function getFileName(protoUrl?: string): string {
  if (!protoUrl) return "inline.proto";
  try {
    return decodeURIComponent(new URL(protoUrl).pathname.split("/").pop() || "contract.proto");
  } catch {
    return "contract.proto";
  }
}

async function fetchProtoText(protoUrl: string): Promise<string> {
  const url = new URL(protoUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP(S) contract URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials embedded in URLs are not allowed.");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Host '${url.hostname}' is not in PROTO_ALLOWED_HOSTS.`);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Non-local contract sources must use HTTPS.");
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
    headers: { accept: "text/plain, application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`Contract fetch failed with HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (!text.trim()) throw new Error("The contract source is empty.");
  if (text.length > 1_000_000) throw new Error("The contract source exceeds 1 MB.");
  return text;
}

app.get("/healthz", (_req, res) => res.json({ ok: true, service: "protobuf-converter" }));

// Fixture endpoint for local end-to-end testing. Not an internal platform API.
app.get("/contracts/order.proto", async (_req, res) => {
  try {
    res.type("text/plain").send(await readFile(fixturePath, "utf8"));
  } catch {
    res.status(500).json({ error: "Fixture could not be loaded." });
  }
});

app.post("/convert", async (req, res) => {
  const parsed = ConvertBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const input = parsed.data;
    const protoText = input.protoText ?? await fetchProtoText(input.protoUrl!);
    const generated = generateTypeScript(protoText);
    const result: ConvertResponse = {
      success: true,
      sourceName: getFileName(input.protoUrl),
      ...(input.protoUrl ? { sourceUrl: input.protoUrl } : {}),
      ...(input.contractVersion ? { contractVersion: input.contractVersion } : {}),
      sha256: createHash("sha256").update(protoText).digest("hex"),
      files: [{ path: generated.sourceName, content: generated.content }],
      warnings: generated.warnings,
    };
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(422).json({ error: "Conversion failed", message });
  }
});

const port = Number(process.env.CONVERTER_PORT ?? 4100);
app.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.error(`Protobuf conversion demo listening on http://127.0.0.1:${port}`);
});
