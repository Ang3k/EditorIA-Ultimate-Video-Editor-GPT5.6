export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function getCodexCliCommand() {
  return process.env.CODEX_CLI_BIN?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
}

export function getCodexModel() {
  return process.env.CODEX_MODEL?.trim() || "gpt-5.6-luna";
}

export function getCodexReasoningEffort(): CodexReasoningEffort {
  const value = process.env.CODEX_REASONING_EFFORT?.trim().toLocaleLowerCase();
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "max";
}

export function getCodexTimeoutMs() {
  const value = Number(process.env.CODEX_TIMEOUT_MS || "900000");
  return Number.isFinite(value) && value >= 30_000 ? Math.min(Math.floor(value), 1_800_000) : 900_000;
}

export function getCodexMaxRetries() {
  const value = Number(process.env.CODEX_MAX_RETRIES || "1");
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 2) : 1;
}

export function getLocalWhisperModel() {
  return process.env.LOCAL_WHISPER_MODEL?.trim() || "large-v3-turbo";
}

export function getLocalWhisperDevice() {
  return process.env.LOCAL_WHISPER_DEVICE?.trim() || "cuda";
}

export function getLocalWhisperComputeType() {
  return process.env.LOCAL_WHISPER_COMPUTE_TYPE?.trim() || "float16";
}

export function getYouTubeSearchProvider() {
  return "yt-dlp" as const;
}

export function getMaxYouTubeSearches() {
  const value = Number(process.env.YOUTUBE_MAX_SEARCHES || "36");
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 48) : 36;
}

export function getAiRuntime() {
  return {
    provider: "codex-cli" as const,
    model: getCodexModel(),
    reasoningEffort: getCodexReasoningEffort(),
    label: `${getCodexModel()} · ${getCodexReasoningEffort()} · Codex CLI`,
  };
}
