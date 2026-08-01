import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobState } from "./types";

const jobsRoot = path.join(process.cwd(), "work", "jobs");

export function getJobsRoot() {
  return jobsRoot;
}

export function getJobDirectory(jobId: string) {
  if (!/^[a-z0-9-]+$/i.test(jobId)) {
    throw new Error("ID de job inválido.");
  }

  return path.join(jobsRoot, jobId);
}

export function getJobFile(jobId: string, fileName: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error("Nome de arquivo inválido.");
  }

  return path.join(getJobDirectory(jobId), fileName);
}

export async function ensureJobDirectory(jobId: string) {
  const directory = getJobDirectory(jobId);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function createJob(input: {
  originalAudioName: string;
  audioFileName: string;
  brief: string;
}) {
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const job: JobState = {
    id,
    status: "received",
    progress: 0,
    message: "Áudio recebido. Preparando a análise.",
    createdAt: now,
    updatedAt: now,
    originalAudioName: input.originalAudioName,
    audioFileName: input.audioFileName,
    brief: input.brief,
  };

  await ensureJobDirectory(id);
  await saveJob(job);
  return job;
}

export async function readJob(jobId: string): Promise<JobState> {
  const file = getJobFile(jobId, "job.json");
  const content = await readFile(file, "utf8");
  return JSON.parse(content) as JobState;
}

export async function saveJob(job: JobState) {
  await ensureJobDirectory(job.id);
  const nextJob = { ...job, updatedAt: new Date().toISOString() };
  await writeFile(getJobFile(job.id, "job.json"), JSON.stringify(nextJob, null, 2), "utf8");
  return nextJob;
}

export async function updateJob(jobId: string, patch: Partial<JobState>) {
  const current = await readJob(jobId);
  return saveJob({ ...current, ...patch });
}

export async function saveArtifact(jobId: string, fileName: string, value: unknown) {
  await ensureJobDirectory(jobId);
  await writeFile(getJobFile(jobId, fileName), JSON.stringify(value, null, 2), "utf8");
}

export async function readArtifact<T>(jobId: string, fileName: string): Promise<T> {
  const content = await readFile(getJobFile(jobId, fileName), "utf8");
  return JSON.parse(content) as T;
}
