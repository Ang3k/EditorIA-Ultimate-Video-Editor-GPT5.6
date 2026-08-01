import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createJob, getJobFile } from "@/lib/job-store";
import { startJobPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedExtensions = new Set([".mp3", ".wav", ".m4a", ".mp4", ".mpeg", ".mpga", ".webm"]);

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const brief = String(formData.get("brief") || "").trim();

    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "Envie um arquivo de áudio." }, { status: 400 });
    }

    const extension = path.extname(audio.name).toLocaleLowerCase() || ".webm";
    if (!allowedExtensions.has(extension)) {
      return NextResponse.json({ error: "Formato não suportado. Use MP3, WAV, M4A, MP4 ou WEBM." }, { status: 400 });
    }

    const bytes = Buffer.from(await audio.arrayBuffer());
    if (bytes.length === 0) {
      return NextResponse.json({ error: "O arquivo está vazio." }, { status: 400 });
    }
    if (bytes.length > 200_000_000) {
      return NextResponse.json({ error: "O arquivo excede o limite local de 200 MB." }, { status: 413 });
    }

    const fileName = `audio${extension}`;
    const job = await createJob({
      originalAudioName: audio.name,
      audioFileName: fileName,
      brief,
    });
    await mkdir(path.dirname(getJobFile(job.id, fileName)), { recursive: true });
    await writeFile(getJobFile(job.id, fileName), bytes);
    startJobPipeline(job.id);

    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível criar o job." },
      { status: 500 },
    );
  }
}
