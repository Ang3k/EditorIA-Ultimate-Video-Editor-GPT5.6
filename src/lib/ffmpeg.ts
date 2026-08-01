import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function runCommand(command: string, args: string[], options?: { cwd?: string }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      windowsHide: true,
      shell: false,
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
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
  if (stats.size <= 24_000_000) {
    return inputPath;
  }

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

export async function createPlaceholder(outputPath: string, duration: number) {
  await runCommand("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x151a2b:s=1920x1080:r=30",
    "-t",
    duration.toFixed(3),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ]);
}

export async function normalizeVideo(inputPath: string, outputPath: string, duration: number) {
  await runCommand("ffmpeg", [
    "-y",
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
    outputPath,
  ]);
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

  const videoArgs = [
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
  ];

  await runCommand("ffmpeg", videoArgs);
  await unlink(concatPath).catch(() => undefined);
}
