import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  getCodexCliCommand,
  getCodexMaxRetries,
  getCodexModel,
  getCodexReasoningEffort,
  getCodexTimeoutMs,
} from "./config";

interface CodexJsonRequest<T> {
  prompt: string;
  schema: Record<string, unknown>;
  stage: string;
  jobDirectory?: string;
  images?: string[];
  parse: (value: unknown) => T;
}

let queueTail: Promise<void> = Promise.resolve();

async function enqueue<T>(task: () => Promise<T>) {
  const previous = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function cleanModelText(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseModelJson(value: string) {
  const cleaned = cleanModelText(value);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const objectStart = cleaned.indexOf("{");
    const objectEnd = cleaned.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(cleaned.slice(objectStart, objectEnd + 1)) as unknown;
    }
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1)) as unknown;
    }
    throw new Error("O Codex CLI não retornou JSON válido.");
  }
}

function runProcess(command: string, args: string[], prompt: string, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const useShell = process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(command);
    const childEnv = { ...process.env };
    // The app may still have an old API key in .env.local. Codex must use the
    // user's local ChatGPT login, never that stale API-key path.
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: useShell,
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`O Codex CLI excedeu o limite de ${Math.round(getCodexTimeoutMs() / 1000)} segundos.`));
    }, getCodexTimeoutMs());

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Não foi possível iniciar o Codex CLI: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`O Codex CLI terminou com código ${code}. ${stderr.slice(-2500) || stdout.slice(-2500)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

async function runOnce<T>(input: CodexJsonRequest<T>) {
  const root = input.jobDirectory || path.join(process.cwd(), ".codex-runtime");
  const requestId = `${input.stage}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const requestDirectory = path.join(root, "codex-requests");
  const schemaPath = path.join(requestDirectory, `${requestId}.schema.json`);
  const outputPath = path.join(requestDirectory, `${requestId}.output.txt`);
  await mkdir(requestDirectory, { recursive: true });
  await writeFile(schemaPath, JSON.stringify(input.schema), "utf8");

  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--model",
    getCodexModel(),
    "-c",
    `model_reasoning_effort=${getCodexReasoningEffort()}`,
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
    "-C",
    process.cwd(),
  ];
  for (const image of input.images || []) args.push("-i", image);
  args.push("-");

  try {
    const result = await runProcess(getCodexCliCommand(), args, input.prompt, process.cwd());
    const outputText = await readFile(outputPath, "utf8").catch(() => result.stdout);
    return input.parse(parseModelJson(outputText));
  } finally {
    await unlink(schemaPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}

export async function runCodexJson<T>(input: CodexJsonRequest<T>) {
  return enqueue(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= getCodexMaxRetries(); attempt += 1) {
      try {
        return await runOnce(input);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Falha desconhecida no Codex CLI.");
  });
}
