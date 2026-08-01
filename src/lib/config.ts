export function getRequiredEnv(name: "GEMINI_API_KEY" | "YOUTUBE_API_KEY") {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`A variável ${name} não está configurada no .env.local.`);
  }

  return value;
}

export function getGeminiModel() {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
}

export function getMaxYouTubeSearches() {
  const value = Number(process.env.YOUTUBE_MAX_SEARCHES || "8");
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 30) : 8;
}
