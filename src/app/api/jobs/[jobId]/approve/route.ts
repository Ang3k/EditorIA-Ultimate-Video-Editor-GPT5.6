import { NextResponse } from "next/server";
import { readJob } from "@/lib/job-store";
import { startFinalRender } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (job.status !== "awaiting_approval" && job.status !== "completed") {
      return NextResponse.json({ error: "O preview ainda não está pronto para aprovação." }, { status: 409 });
    }

    startFinalRender(jobId);
    return NextResponse.json({ ok: true, message: "Exportação iniciada." }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível iniciar a exportação." },
      { status: 500 },
    );
  }
}
