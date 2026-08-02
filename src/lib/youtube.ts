import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getMaxYouTubeSearches } from "./config";
import { runCommand } from "./ffmpeg";
import type { CandidateSourceKind, VisualUnit, YouTubeCandidate } from "./types";

const BASE_UNIT_ID = "base";

interface YtDlpSearchResponse {
  entries?: Array<{
    id?: string;
    title?: string;
    description?: string | null;
    channel?: string;
    uploader?: string;
    webpage_url?: string;
    url?: string;
    upload_date?: string;
    release_timestamp?: number | null;
    duration?: number | null;
    thumbnails?: Array<{ url?: string }>;
  }>;
}

type YtDlpEntry = NonNullable<YtDlpSearchResponse["entries"]>[number];

const blockedTitlePattern = /\b(?:reaction|reacts|explained|explanation|theory|analysis|essay|lore|iceberg|review|podcast|compilation|shorts?|comic\s+dub|fan\s+animation|fan\s+edit|montage|highlights?|best\s+moments?|let'?s\s+play|with\s+commentary|facecam|reaction|youtuber|edited)\b/i;
const rawGameplayPattern = /\b(?:gameplay|playthrough|walkthrough|no\s+commentary|raw\s+footage|longplay|chapter\s+\d+)\b/i;
const cutscenePattern = /\b(?:cutscene|cut\s*scene|scene\s+collection|dialogue|dialog)\b/i;
const officialPattern = /\b(?:official|trailer|demo|showcase)\b/i;
const genericSearchTerms = new Set([
  "deltarune",
  "undertale",
  "gameplay",
  "game",
  "video",
  "chapter",
  "chapters",
  "full",
  "raw",
  "playthrough",
  "longplay",
  "walkthrough",
  "scene",
  "cutscene",
  "dialogue",
  "dialog",
  "clip",
  "moments",
  "no",
  "commentary",
]);

function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function meaningfulTerms(values: string[]) {
  return [...new Set(values
    .flatMap((value) => normalizeSearchText(value).split(/[^\p{L}\p{N}]+/u))
    .filter((term) => term.length >= 4 && !genericSearchTerms.has(term)))];
}

export function classifySourceKind(title: string, description = ""): CandidateSourceKind {
  const text = normalizeSearchText(`${title} ${description}`);
  if (blockedTitlePattern.test(text)) return "edited_creator";
  if (rawGameplayPattern.test(text)) return "raw_gameplay";
  if (cutscenePattern.test(text)) return "cutscene";
  if (officialPattern.test(text)) return "official_footage";
  return "unknown";
}

export function hasBlockedSourceTitle(candidate: Pick<YouTubeCandidate, "title" | "description">) {
  return blockedTitlePattern.test(normalizeSearchText(`${candidate.title} ${candidate.description}`));
}

export function isDirectCandidate(candidate: YouTubeCandidate, unit: VisualUnit) {
  if (hasBlockedSourceTitle(candidate)) return false;
  if (candidate.sourceKind === "edited_creator") return false;

  const searchableText = normalizeSearchText(`${candidate.title} ${candidate.description}`);
  const mustShowTerms = meaningfulTerms(unit.mustShow);
  const queryTerms = meaningfulTerms(unit.queries);
  const mustShowMatch = mustShowTerms.length === 0 || mustShowTerms.some((term) => searchableText.includes(term));
  const queryMatch = queryTerms.length === 0 || queryTerms.some((term) => searchableText.includes(term));
  const sourceTypeMatch = candidate.sourceKind === "raw_gameplay" || candidate.sourceKind === "cutscene" || candidate.sourceKind === "official_footage";
  return mustShowMatch && queryMatch && sourceTypeMatch;
}

export function isBaseCandidate(candidate: YouTubeCandidate, query = "") {
  if (hasBlockedSourceTitle(candidate)) return false;
  if (candidate.sourceKind === "edited_creator") return false;
  const topic = meaningfulTerms([query])[0];
  if (topic && !normalizeSearchText(`${candidate.title} ${candidate.description}`).includes(topic)) return false;
  return candidate.sourceKind === "raw_gameplay" || candidate.sourceKind === "cutscene" || candidate.sourceKind === "official_footage";
}

function parseYtDlpJson(output: string) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("O yt-dlp não retornou resultados de busca válidos.");
  }

  return JSON.parse(output.slice(start, end + 1)) as YtDlpSearchResponse;
}

function publishedAtFromYtDlpEntry(entry: YtDlpEntry) {
  if (typeof entry.release_timestamp === "number") {
    return new Date(entry.release_timestamp * 1000).toISOString();
  }

  if (entry.upload_date && /^\d{8}$/.test(entry.upload_date)) {
    return `${entry.upload_date.slice(0, 4)}-${entry.upload_date.slice(4, 6)}-${entry.upload_date.slice(6, 8)}T00:00:00.000Z`;
  }

  return "";
}

async function searchYouTubeWithYtDlp(query: string, unitId: string) {
  const yt = getYtDlpCommand();
  const output = await runCommand(yt.command, [
    ...yt.args,
    ...getYtDlpExtractorArgs(),
    "--flat-playlist",
    "--dump-single-json",
    "--skip-download",
    "--ignore-errors",
    "--no-warnings",
    "--quiet",
    "--playlist-end",
    "8",
    `ytsearch8:${query}`,
  ]);
  const data = parseYtDlpJson(output);

  return (data.entries || []).flatMap((entry) => {
    if (!entry.id) return [];
    const title = String(entry.title || "Sem título");
    const description = String(entry.description || "");
    const url = entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`;
    const thumbnailUrl = entry.thumbnails?.at(-1)?.url;
    const candidate: YouTubeCandidate = {
      id: entry.id,
      unitId,
      query,
      title,
      description,
      channelTitle: String(entry.channel || entry.uploader || ""),
      publishedAt: publishedAtFromYtDlpEntry(entry),
      url,
      duration: typeof entry.duration === "number" ? entry.duration : undefined,
      sourceKind: classifySourceKind(title, description),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    };
    return [candidate];
  });
}

export interface YouTubeSearchResults {
  candidates: YouTubeCandidate[];
  baseCandidates: YouTubeCandidate[];
}

function baseSearchQueries(baseQuery: string) {
  const lead = baseQuery.split(/[,;:|]/)[0]?.trim() || baseQuery.trim();
  const terms = meaningfulTerms([lead]);
  const gameTerms = terms.slice(0, 4).join(" ");
  const shortGame = terms.slice(0, 2).join(" ") || lead;
  const compactLead = lead
    .replace(/\b(?:full|raw|playthrough|longplay|walkthrough|gameplay|no|commentary)\b/gi, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return [...new Set([
    baseQuery.trim(),
    `${compactLead} gameplay no commentary`,
    `${lead} gameplay no commentary`,
    `${gameTerms} gameplay no commentary`,
    `${shortGame} full game walkthrough no commentary`,
    `${shortGame} longplay no commentary`,
  ].filter(Boolean))];
}

export async function searchCandidates(units: VisualUnit[], baseQuery: string): Promise<YouTubeSearchResults> {
  const maxSearches = getMaxYouTubeSearches();
  const candidates: YouTubeCandidate[] = [];
  const baseCandidates: YouTubeCandidate[] = [];
  const seenQueries = new Set<string>();
  const seenCandidates = new Set<string>();
  let searches = 0;

  async function runSearch(query: string, unitId: string) {
    const normalized = `${unitId}:${query.trim().toLocaleLowerCase()}`;
    if (!query.trim() || seenQueries.has(normalized) || searches >= maxSearches) return;
    seenQueries.add(normalized);
    searches += 1;
    const results = await searchYouTubeWithYtDlp(query.trim(), unitId).catch(() => []);
    for (const candidate of results) {
      const key = `${unitId}:${candidate.id}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      if (unitId === BASE_UNIT_ID) {
        if (isBaseCandidate(candidate, query)) baseCandidates.push(candidate);
      } else {
        const unit = units.find((item) => item.id === unitId);
        if (unit && isDirectCandidate(candidate, unit)) candidates.push(candidate);
      }
    }
  }

  for (const query of baseSearchQueries(baseQuery)) {
    await runSearch(query, BASE_UNIT_ID);
    if (baseCandidates.length >= 6 || searches >= maxSearches) break;
  }
  for (const queryIndex of [0, 1, 2]) {
    for (const unit of units) {
      if (searches >= maxSearches) break;
      await runSearch(unit.queries[queryIndex] || "", unit.id);
    }
    if (searches >= maxSearches) break;
  }

  return { candidates, baseCandidates };
}

function getYtDlpCommand() {
  const configured = process.env.YTDLP_BIN?.trim();
  if (configured) return { command: configured, args: [] as string[] };
  if (process.platform === "win32") return { command: "py", args: ["-m", "yt_dlp"] };
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
    const match = block.match(/(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?)\s+-->(\s*)(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?)[^\n]*\n([\s\S]*)/);
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[3]);
    if (start === null || end === null) continue;
    const text = match[4]
      .replace(/<[^>]+>/g, " ")
      .replace(/\{[^}]+\}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

export async function locateCaptionStart(input: { url: string; directory: string; terms: string[] }) {
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

  const keywords = input.terms.join(" ").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3);
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

export async function downloadClip(input: { url: string; outputPath: string; start: number; duration: number }) {
  const yt = getYtDlpCommand();
  const safeStart = Math.max(0, input.start);
  const safeEnd = safeStart + Math.max(2, input.duration);
  await runCommand(yt.command, [
    ...yt.args,
    ...getYtDlpExtractorArgs(),
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-part",
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
