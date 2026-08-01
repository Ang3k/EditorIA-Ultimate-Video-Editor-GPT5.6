import { NextResponse } from "next/server";
import { readJob } from "@/lib/job-store";
import { startEditorPreviewRender } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (!job.editorProject) {
      return NextResponse.json({ error: "Salve o projeto antes de renderizar o preview." }, { status: 409 });
    }
    startEditorPreviewRender(jobId);
    return NextResponse.json({ ok: true, message: "Atualização do preview iniciada." }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível atualizar o preview." },
      { status: 500 },
    );
  }
}
