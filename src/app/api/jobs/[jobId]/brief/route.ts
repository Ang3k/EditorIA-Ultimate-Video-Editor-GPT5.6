import { NextResponse } from "next/server";
import {
  creativeBriefHasRequiredAnswers,
  normalizeCreativeAnswers,
} from "@/lib/creative-brief";
import { readJob, saveArtifact, updateJob } from "@/lib/job-store";
import { startCreativeBriefPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (!job.creativeBrief || !job.transcript) {
      return NextResponse.json({ error: "A direção criativa ainda não está disponível." }, { status: 409 });
    }
    if (job.status !== "awaiting_direction") {
      return NextResponse.json({ error: "Este job não está aguardando direção criativa." }, { status: 409 });
    }

    const body = (await request.json()) as { answers?: unknown };
    const answers = normalizeCreativeAnswers(job.creativeBrief.questions, body.answers);
    const creativeBrief = {
      ...job.creativeBrief,
      answers,
      submittedAt: new Date().toISOString(),
    };
    if (!creativeBriefHasRequiredAnswers(creativeBrief)) {
      return NextResponse.json({ error: "Responda às perguntas marcadas como obrigatórias." }, { status: 400 });
    }

    await saveArtifact(jobId, "creative-brief.json", creativeBrief);
    const nextJob = await updateJob(jobId, {
      creativeBrief,
      status: "planning",
      progress: 20,
      message: "Direção recebida. Refinando buscas e montagem…",
      error: undefined,
    });
    startCreativeBriefPipeline(jobId);
    return NextResponse.json(nextJob, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível salvar a direção criativa." },
      { status: 400 },
    );
  }
}
