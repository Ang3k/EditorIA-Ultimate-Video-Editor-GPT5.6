import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getMaxYouTubeSearches, getRequiredEnv } from "./config";
import { runCommand } from "./ffmpeg";
import type { VisualUnit, YouTubeCandidate } from "./types";

interface YouTubeSearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: { medium?: { url?: string } };
    };
  }>;
}

async function searchYouTube(query: string, unitId: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("q", query);
  url.searchParams.set("safeSearch", "none");
  url.searchParams.set("key", getRequiredEnv("YOUTUBE_API_KEY"));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YouTube Data API respondeu HTTP ${response.status}.`);
  }

  const data = (await response.json()) as YouTubeSearchResponse;
  return (data.items || []).flatMap((item) => {
      const id = item.id?.videoId;
      if (!id) return [];
      const snippet = item.snippet || {};
      const candidate: YouTubeCandidate = {
        id,
        unitId,
        query,
        title: String(snippet.title || "Sem título"),
        description: String(snippet.description || ""),
        channelTitle: String(snippet.channelTitle || ""),
        publishedAt: String(snippet.publishedAt || ""),
        url: `https://www.youtube.com/watch?v=${id}`,
        ...(snippet.thumbnails?.medium?.url ? { thumbnailUrl: snippet.thumbnails.medium.url } : {}),
      };
      return [candidate];
    });
}

export async function searchCandidates(units: VisualUnit[]) {
  const maxSearches = getMaxYouTubeSearches();
  const candidates: YouTubeCandidate[] = [];
  const seenQueries = new Set<string>();
  let searches = 0;

  for (const unit of units) {
    for (const rawQuery of unit.queries.slice(0, 2)) {
      const query = rawQuery.trim();
      const normalized = query.toLocaleLowerCase();
      if (!query || seenQueries.has(normalized) || searches >= maxSearches) {
        continue;
      }

      seenQueries.add(normalized);
      searches += 1;
      const results = await searchYouTube(query, unit.id);
      candidates.push(...results);

      if (results.length > 0) {
        break;
      }
    }

    if (searches >= maxSearches) {
      break;
    }
  }

  return candidates;
}

function getYtDlpCommand() {
  const configured = process.env.YTDLP_BIN?.trim();
  if (configured) {
    return { command: configured, args: [] as string[] };
  }

  if (process.platform === "win32") {
    return { command: "py", args: ["-m", "yt_dlp"] };
  }

  return { command: "yt-dlp", args: [] as string[] };
}

function getYtDlpExtractorArgs() {
  const playerClient = process.env.YTDLP_PLAYER_CLIENT?.trim() || "android";
  return playerClient ? ["--extractor-args", `youtube:player_client=${playerClient}`] : [];
}

function parseTimestamp(value: string) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function parseVtt(content: string) {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  const blocks = content.replaceAll("\r", "").split("\n\n");
  for (const block of blocks) {
    const match = block.match(
      /(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?)\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?)[^\n]*\n([\s\S]*)/,
    );
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (start === null || end === null) continue;
    const text = match[3]
      .replace(/<[^>]+>/g, " ")
      .replace(/\{[^}]+\}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

export async function locateCaptionStart(input: {
  url: string;
  directory: string;
  terms: string[];
}) {
  await mkdir(input.directory, { recursive: true });
  const outputTemplate = path.join(input.directory, "captions");
  const yt = getYtDlpCommand();

  await runCommand(yt.command, [
    ...yt.args,
    ...getYtDlpExtractorArgs(),
    "--no-playlist",
    "--skip-download",
    "--ignore-errors",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "pt.*,en.*",
    "--sub-format",
    "vtt",
    "-o",
    outputTemplate,
    input.url,
  ]).catch(() => undefined);

  const files = await readdir(input.directory).catch(() => []);
  const captionFiles = files.filter((file) => file.endsWith(".vtt"));
  if (captionFiles.length === 0) return null;

  const keywords = input.terms
    .join(" ")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3);
  if (keywords.length === 0) return null;

  let best: { start: number; score: number } | null = null;
  for (const file of captionFiles) {
    const cues = parseVtt(await readFile(path.join(input.directory, file), "utf8"));
    for (const cue of cues) {
      const haystack = cue.text.toLocaleLowerCase();
      const score = keywords.reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);
      if (score > 0 && (!best || score > best.score || (score === best.score && cue.start < best.start))) {
        best = { start: cue.start, score };
      }
    }
  }

  return best ? Math.max(0, best.start - 1.5) : null;
}

export async function downloadClip(input: {
  url: string;
  outputPath: string;
  start: number;
  duration: number;
}) {
  const yt = getYtDlpCommand();
  const safeStart = Math.max(0, input.start);
  const safeEnd = safeStart + Math.max(2, input.duration);
  await runCommand(yt.command, [
    ...yt.args,
    ...getYtDlpExtractorArgs(),
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--force-overwrites",
    "-f",
    "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format",
    "mp4",
    "--download-sections",
    `*${safeStart.toFixed(3)}-${safeEnd.toFixed(3)}`,
    "--force-keyframes-at-cuts",
    "-o",
    input.outputPath,
    input.url,
  ]);
}
