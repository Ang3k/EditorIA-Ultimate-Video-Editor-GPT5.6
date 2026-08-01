import { NextResponse } from "next/server";
import { createEditorProject, normalizeEditorProject } from "@/lib/editor-project";
import { readJob, saveArtifact, updateJob } from "@/lib/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    const project = job.editorProject ? normalizeEditorProject(job.editorProject, job) : createEditorProject(job);
    if (!job.editorProject) {
      await saveArtifact(jobId, "editor-project.json", project);
      await updateJob(jobId, { editorProject: project });
    }
    return NextResponse.json(project);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Projeto do editor não encontrado." },
      { status: 404 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    const body = (await request.json()) as { project?: unknown };
    const project = normalizeEditorProject(body.project ?? body, job);
    await saveArtifact(jobId, "editor-project.json", project);
    const nextJob = await updateJob(jobId, { editorProject: project });
    return NextResponse.json({ project, job: nextJob });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível salvar o projeto." },
      { status: 400 },
    );
  }
}
