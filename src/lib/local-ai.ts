import path from "node:path";
import { getLocalWhisperComputeType, getLocalWhisperDevice, getLocalWhisperModel } from "./config";
import { runCommand } from "./ffmpeg";
import type { TranscriptDocument } from "./types";

function localScriptPath() {
  return path.join(process.cwd(), "scripts", "transcribe_local.py");
}

export async function transcribeLocalAudio(filePath: string): Promise<TranscriptDocument> {
  const output = await runCommand("py", [
    localScriptPath(),
    filePath,
    "--model",
    getLocalWhisperModel(),
    "--device",
    getLocalWhisperDevice(),
    "--compute-type",
    getLocalWhisperComputeType(),
  ]);
  const jsonLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!jsonLine) {
    throw new Error("O Whisper local não retornou a transcrição.");
  }

  return JSON.parse(jsonLine) as TranscriptDocument;
}
