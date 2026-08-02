import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EditorProject } from "./types";

export async function runCommand(command: string, args: string[], options?: { cwd?: string }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      windowsHide: true,
      shell: false,
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} terminou com código ${code}.\n${output.slice(-4000)}`));
      }
    });
  });
}

export async function getMediaDuration(filePath: string) {
  const output = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(output) as { format?: { duration?: string } };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Não foi possível descobrir a duração da mídia.");
  }
  return duration;
}

export async function prepareAudioForTranscription(inputPath: string, outputPath: string) {
  const stats = await import("node:fs/promises").then((fs) => fs.stat(inputPath));
  if (stats.size <= 24_000_000) return inputPath;

  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    outputPath,
  ]);
  return outputPath;
}

export async function normalizeVideo(inputPath: string, outputPath: string, duration: number) {
  await runCommand("ffmpeg", [
    "-y",
    "-stream_loop",
    "-1",
    "-i",
    inputPath,
    "-t",
    duration.toFixed(3),
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

export async function extractContactSheet(inputPath: string, outputPath: string, duration: number) {
  const fps = Math.max(0.1, Math.min(2, 6 / Math.max(duration, 6)));
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `fps=${fps.toFixed(4)},scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,tile=3x2:padding=4:margin=4`,
    "-frames:v",
    "1",
    "-an",
    outputPath,
  ]);
}

export async function hasExtendedBlackFrame(inputPath: string) {
  const output = await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "info",
    "-i",
    inputPath,
    "-vf",
    "blackdetect=d=0.35:pix_th=0.02",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  return [...output.matchAll(/black_duration:([0-9.]+)/g)].some((match) => Number(match[1]) >= 0.35);
}

function escapeConcatPath(filePath: string) {
  return filePath.replaceAll("\\", "/").replaceAll("'", "'\\''");
}

export async function renderTimeline(input: {
  jobDirectory: string;
  segments: Array<{ fileName: string; duration: number }>;
  narrationPath: string;
  outputPath: string;
  quality: "preview" | "final";
}) {
  const concatPath = path.join(input.jobDirectory, `concat-${input.quality}.txt`);
  const concatContent = input.segments
    .map((segment) => `file '${escapeConcatPath(path.join(input.jobDirectory, segment.fileName))}'`)
    .join("\n");
  await writeFile(concatPath, `${concatContent}\n`, "utf8");

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-i",
      input.narrationPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      input.quality === "final" ? "medium" : "veryfast",
      "-crf",
      input.quality === "final" ? "18" : "24",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      input.outputPath,
    ]);
  } finally {
    await unlink(concatPath).catch(() => undefined);
  }
}

export async function renderEditorProject(input: {
  jobDirectory: string;
  project: EditorProject;
  narrationPath: string;
  outputPath: string;
  quality: "preview" | "final";
}) {
  const duration = Math.max(0.1, input.project.duration);
  const videoClips = input.project.clips
    .filter((clip) => clip.assetType === "video" && clip.assetFileName && (clip.trackId === "V1" || clip.trackId === "V2"))
    .sort((left, right) => {
      const leftTrackOrder = left.trackId === "V1" ? 0 : 1;
      const rightTrackOrder = right.trackId === "V1" ? 0 : 1;
      return leftTrackOrder - rightTrackOrder || left.start - right.start;
    });
  const baseClip = videoClips.find((clip) => clip.role === "base" || (clip.trackId === "V1" && clip.unitId === "base"));
  if (!baseClip || baseClip.start > 0.05 || baseClip.start + baseClip.duration < duration - 0.05) {
    throw new Error("A gameplay-base não cobre toda a duração; o render foi interrompido para evitar tela preta.");
  }

  const audioTrack = input.project.tracks.find((track) => track.id === "A1");
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-t",
    duration.toFixed(3),
    "-i",
    `color=c=0x151a2b:s=${input.project.width}x${input.project.height}:r=${input.project.fps}`,
  ];

  for (const clip of videoClips) {
    args.push(
      "-ss",
      Math.max(0, clip.sourceStart).toFixed(3),
      "-t",
      Math.min(clip.duration, clip.sourceDuration).toFixed(3),
      "-i",
      path.join(input.jobDirectory, clip.assetFileName as string),
    );
  }

  const audioInputIndex = videoClips.length + 1;
  args.push("-i", input.narrationPath);

  const filters = ["[0:v]format=yuv420p[base0]"];
  let currentLabel = "base0";
  videoClips.forEach((clip, index) => {
    const inputIndex = index + 1;
    const clipLabel = `clip${index}`;
    const nextLabel = `mix${index}`;
    const clipDuration = Math.min(clip.duration, clip.sourceDuration);
    filters.push(
      `[${inputIndex}:v]trim=duration=${clipDuration.toFixed(3)},setpts=PTS-STARTPTS+${Math.max(0, clip.start).toFixed(3)}/TB,scale=${input.project.width}:${input.project.height}:force_original_aspect_ratio=increase,crop=${input.project.width}:${input.project.height},setsar=1,format=yuv420p[${clipLabel}]`,
      `[${currentLabel}][${clipLabel}]overlay=0:0:eof_action=pass:shortest=0:format=auto[${nextLabel}]`,
    );
    currentLabel = nextLabel;
  });
  filters.push(`[${currentLabel}]format=yuv420p[vout]`);

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audioTrack?.muted) {
    args.push("-an");
  } else {
    args.push("-map", `${audioInputIndex}:a:0`, "-af", "apad");
  }
  args.push(
    "-t",
    duration.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    input.quality === "final" ? "medium" : "veryfast",
    "-crf",
    input.quality === "final" ? "18" : "24",
    ...(audioTrack?.muted ? [] : ["-c:a", "aac", "-b:a", "192k"]),
    "-movflags",
    "+faststart",
    input.outputPath,
  );

  await runCommand("ffmpeg", args);
}
