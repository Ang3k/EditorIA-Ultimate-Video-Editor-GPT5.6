export function getRequiredEnv(name: "OPENAI_API_KEY" | "YOUTUBE_API_KEY") {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`A variável ${name} não está configurada no .env.local.`);
  }

  return value;
}

export function getEditorModel() {
  return process.env.OPENAI_EDITOR_MODEL?.trim() || "gpt-5.6-luna";
}

export function getReasoningEffort() {
  return process.env.OPENAI_REASONING_EFFORT?.trim() || "max";
}

export function getMaxYouTubeSearches() {
  const value = Number(process.env.YOUTUBE_MAX_SEARCHES || "8");
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 30) : 8;
}
