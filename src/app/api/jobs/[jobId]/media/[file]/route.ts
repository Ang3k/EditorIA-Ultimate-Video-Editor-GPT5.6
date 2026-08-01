import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getJobFile } from "@/lib/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedFiles = new Set(["preview.mp4", "final.mp4"]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string; file: string }> },
) {
  try {
    const { jobId, file } = await context.params;
    if (!allowedFiles.has(file)) {
      return NextResponse.json({ error: "Arquivo não permitido." }, { status: 404 });
    }

    const content = await readFile(getJobFile(jobId, file));
    return new NextResponse(content, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(content.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Mídia não encontrada." }, { status: 404 });
  }
}
