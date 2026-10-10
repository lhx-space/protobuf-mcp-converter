import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GeneratedFile } from "./contracts.js";

function assertWithin(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to write outside WORKSPACE_ROOT: ${target}`);
  }
}

async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  assertWithin(root, target);
  const rel = relative(root, target);
  const parts = rel.split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to write through symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function writeGeneratedFiles(
  outputDir: string,
  files: GeneratedFile[],
): Promise<string[]> {
  if (isAbsolute(outputDir)) {
    throw new Error("outputDir must be relative to WORKSPACE_ROOT.");
  }

  const configuredRoot = resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
  await mkdir(configuredRoot, { recursive: true });
  const workspaceRoot = await realpath(configuredRoot);
  const resolvedOutput = resolve(workspaceRoot, outputDir);
  assertWithin(workspaceRoot, resolvedOutput);
  await rejectSymlinkComponents(workspaceRoot, resolvedOutput);
  await mkdir(resolvedOutput, { recursive: true });

  const written: string[] = [];
  for (const file of files) {
    if (!file.path || isAbsolute(file.path)) throw new Error("Generated file path must be relative.");
    const destination = resolve(resolvedOutput, file.path);
    assertWithin(resolvedOutput, destination);
    await rejectSymlinkComponents(workspaceRoot, destination);
    await mkdir(dirname(destination), { recursive: true });

    const tempPath = `${destination}.${randomUUID()}.tmp`;
    await writeFile(tempPath, file.content, { encoding: "utf8", flag: "wx" });
    try {
      await rename(tempPath, destination);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    written.push(relative(workspaceRoot, destination));
  }
  return written;
}
