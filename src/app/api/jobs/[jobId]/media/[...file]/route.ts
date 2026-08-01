import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getJobDirectory } from "@/lib/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentType(fileName: string) {
  const extension = path.extname(fileName).toLocaleLowerCase();
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".webm") return "audio/webm";
  return "video/mp4";
}

function isAllowedMedia(fileName: string) {
  return /^(?:preview|final)\.mp4$/.test(fileName)
    || /^audio\.(?:mp3|m4a|wav|webm|mp4)$/.test(fileName)
    || /^segments\/segment-\d+\.mp4$/.test(fileName);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string; file: string[] }> },
) {
  try {
    const { jobId, file } = await context.params;
    const relativeFile = file.join("/");
    if (!isAllowedMedia(relativeFile)) {
      return NextResponse.json({ error: "Arquivo não permitido." }, { status: 404 });
    }

    const jobDirectory = path.resolve(getJobDirectory(jobId));
    const filePath = path.resolve(jobDirectory, relativeFile);
    if (!filePath.startsWith(`${jobDirectory}${path.sep}`)) {
      return NextResponse.json({ error: "Arquivo não permitido." }, { status: 404 });
    }

    const fileStats = await stat(filePath);
    const range = request.headers.get("range");
    const type = contentType(relativeFile);
    if (!range) {
      const stream = Readable.toWeb(createReadStream(filePath));
      return new NextResponse(stream as ReadableStream, {
        headers: {
          "Content-Type": type,
          "Content-Length": String(fileStats.size),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return NextResponse.json({ error: "Range inválido." }, { status: 416 });
    const start = match[1] ? Number(match[1]) : Math.max(0, fileStats.size - Number(match[2] || 0));
    const end = match[2] ? Number(match[2]) : fileStats.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || end >= fileStats.size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${fileStats.size}` } });
    }

    const stream = Readable.toWeb(createReadStream(filePath, { start, end }));
    return new NextResponse(stream as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${fileStats.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Mídia não encontrada." }, { status: 404 });
  }
}
