import { NextResponse } from "next/server";
import { readJob, updateJob } from "@/lib/job-store";
import { startJobPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (job.status !== "failed") {
      return NextResponse.json({ error: "Somente jobs que falharam podem ser retomados." }, { status: 409 });
    }
    if (!job.transcript || !job.visualPlan || !job.visualUnits?.length || !job.candidates?.length || !job.creativeBrief?.submittedAt) {
      return NextResponse.json({ error: "Este job não possui artefatos suficientes para uma retomada segura." }, { status: 409 });
    }

    const nextJob = await updateJob(jobId, {
      status: "planning",
      progress: 42,
      message: "Retomando a montagem a partir das fontes já pesquisadas…",
      error: undefined,
    });
    startJobPipeline(jobId);
    return NextResponse.json(nextJob, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível retomar o job." },
      { status: 400 },
    );
  }
}
