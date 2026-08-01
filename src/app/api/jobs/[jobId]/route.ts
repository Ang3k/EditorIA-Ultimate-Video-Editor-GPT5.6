import { NextResponse } from "next/server";
import { readJob } from "@/lib/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    return NextResponse.json(await readJob(jobId));
  } catch {
    return NextResponse.json({ error: "Job não encontrado." }, { status: 404 });
  }
}
