"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { JobState, JobStatus } from "@/lib/types";

const statusLabels: Record<JobStatus, string> = {
  received: "Recebido",
  transcribing: "Transcrevendo",
  planning: "Planejando imagens",
  searching: "Pesquisando B-roll",
  downloading: "Baixando trechos",
  rendering: "Renderizando preview",
  awaiting_approval: "Aguardando aprovação",
  exporting: "Exportando final",
  completed: "Concluído",
  failed: "Falhou",
};

function formatTime(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

export default function Home() {
  const [audio, setAudio] = useState<File | null>(null);
  const [brief, setBrief] = useState("");
  const [job, setJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!job?.id || ["awaiting_approval", "completed", "failed"].includes(job.status)) return;

    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      if (response.ok) setJob((await response.json()) as JobState);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  const previewUrl = useMemo(() => {
    if (!job?.media?.preview) return "";
    return `/api/jobs/${job.id}/media/${job.media.preview}`;
  }, [job]);
  const finalUrl = useMemo(() => {
    if (!job?.media?.final) return "";
    return `/api/jobs/${job.id}/media/${job.media.final}`;
  }, [job]);

  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!audio) {
      setNotice("Escolha uma faixa de áudio primeiro.");
      return;
    }

    setBusy(true);
    setNotice("");
    const formData = new FormData();
    formData.set("audio", audio);
    formData.set("brief", brief);
    const response = await fetch("/api/jobs", { method: "POST", body: formData });
    const data = (await response.json()) as JobState & { error?: string };
    if (!response.ok) {
      setNotice(data.error || "Não foi possível criar o rascunho.");
    } else {
      setJob(data);
    }
    setBusy(false);
  }

  async function approveDraft() {
    if (!job) return;
    setNotice("");
    const response = await fetch(`/api/jobs/${job.id}/approve`, { method: "POST" });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setNotice(data.error || "Não foi possível iniciar a exportação.");
      return;
    }
    setJob((current) => (current ? { ...current, status: "exporting", progress: 5 } : current));
  }

  const canApprove = job?.status === "awaiting_approval";
  const isWorking = Boolean(job && !["awaiting_approval", "completed", "failed"].includes(job.status));

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">✦</span>
          <div>
            <p className="eyebrow">WORKBENCH LOCAL</p>
            <h1>EditorIA</h1>
          </div>
        </div>
        <div className="model-pill"><span className="pulse" /> Gemini 3.6 Flash</div>
      </header>

      <section className="intro">
        <p className="eyebrow accent">NARRAÇÃO → IMAGEM → VÍDEO</p>
        <h2>Grave a ideia.<br /><em>O rascunho se monta.</em></h2>
        <p className="lede">Envie só a sua voz. O EditorIA transcreve, entende cada trecho, pesquisa B-roll contextual e entrega um preview para você revisar.</p>
      </section>

      <section className="workspace-grid">
        <form className="panel upload-panel" onSubmit={createDraft}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">01 · ENTRADA</p>
              <h3>Comece pela narração</h3>
            </div>
            <span className="step-dot">A</span>
          </div>

          <label className={`dropzone ${audio ? "has-file" : ""}`}>
            <input type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" onChange={(event) => setAudio(event.target.files?.[0] || null)} />
            <span className="upload-icon">↥</span>
            <strong>{audio ? audio.name : "Solte o áudio aqui"}</strong>
            <small>{audio ? `${(audio.size / 1024 / 1024).toFixed(1)} MB · pronto para analisar` : "MP3, WAV, M4A ou WEBM"}</small>
          </label>

          <label className="field-label" htmlFor="brief">Contexto opcional</label>
          <textarea
            id="brief"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Ex.: vídeo ensaio sobre a rota estranha de Deltarune. Priorize gameplay e momentos com Noelle usando magia de gelo."
            rows={5}
          />

          <button className="primary-button" type="submit" disabled={busy || !audio}>
            {busy ? "Enviando…" : "Gerar rascunho automático"}<span>→</span>
          </button>
          <p className="microcopy">A narração permanece como trilha principal. O áudio dos vídeos encontrados é silenciado.</p>
        </form>

        <section className="panel status-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">02 · PROCESSAMENTO</p>
              <h3>{job ? "O editor está trabalhando" : "Aguardando uma narração"}</h3>
            </div>
            {job && <span className={`status-badge status-${job.status}`}>{statusLabels[job.status]}</span>}
          </div>

          {!job ? (
            <div className="empty-state">
              <div className="empty-orbit"><span>✦</span></div>
              <p>Seu primeiro job aparecerá aqui.</p>
              <small>O pipeline vai mostrar transcrição, buscas, candidatos e timeline.</small>
            </div>
          ) : (
            <div className="job-state">
              <div className="progress-row"><span>{job.message}</span><strong>{job.progress}%</strong></div>
              <div className="progress-track"><div style={{ width: `${job.progress}%` }} /></div>
              <div className="pipeline-steps">
                {["Transcrição", "Intenção visual", "Busca YouTube", "Preview"].map((label, index) => {
                  const threshold = [10, 25, 45, 86][index];
                  const done = job.progress >= threshold || job.status === "awaiting_approval" || job.status === "completed";
                  return <div className={done ? "pipeline-step done" : "pipeline-step"} key={label}><span>{done ? "✓" : "·"}</span>{label}</div>;
                })}
              </div>
              {job.error && <div className="error-box">{job.error}</div>}
              {job.transcript && (
                <div className="transcript-box">
                  <div className="mini-heading"><span>TRANSCRIÇÃO</span><strong>{formatTime(job.duration)}</strong></div>
                  <p>{job.transcript.text}</p>
                </div>
              )}
            </div>
          )}
        </section>
      </section>

      {job && (job.visualUnits || job.candidates || previewUrl) && (
        <section className="details-grid">
          <section className="panel units-panel">
            <div className="panel-heading compact">
              <div><p className="eyebrow">03 · DECISÕES</p><h3>O que a IA encontrou</h3></div>
              <span className="count-pill">{job.visualUnits?.length || 0} unidades</span>
            </div>
            <div className="unit-list">
              {(job.visualUnits || []).slice(0, 8).map((unit) => {
                const candidate = job.candidates?.find((item) => item.unitId === unit.id);
                return <article className="unit-card" key={unit.id}>
                  <div className="unit-time">{formatTime(unit.start)} — {formatTime(unit.end)}</div>
                  <div><strong>{unit.visualBrief}</strong><p>{candidate?.title || "Placeholder até encontrar um candidato confiável"}</p></div>
                  <span className="confidence">{Math.round(unit.confidence * 100)}%</span>
                </article>;
              })}
              {(!job.visualUnits || job.visualUnits.length === 0) && <p className="muted">As unidades visuais aparecerão depois da transcrição.</p>}
            </div>
          </section>

          <section className="panel preview-panel">
            <div className="panel-heading compact">
              <div><p className="eyebrow">04 · REVISÃO</p><h3>Preview editável</h3></div>
              {canApprove && <button className="approve-button" onClick={approveDraft}>Aprovar e exportar</button>}
            </div>
            {previewUrl && <Link className="editor-link" href={`/editor?job=${job.id}`}>Abrir no editor →</Link>}
            {previewUrl ? (
              <div className="video-wrap"><video controls src={previewUrl} /></div>
            ) : (
              <div className="preview-empty"><span>◌</span><p>O preview será renderizado após a escolha dos trechos.</p></div>
            )}
            {finalUrl && <a className="download-link" href={finalUrl} download="editoria-final.mp4">Baixar vídeo final →</a>}
          </section>
        </section>
      )}

      {notice && <div className="toast">{notice}</div>}
      {isWorking && <div className="working-note">Você pode deixar esta janela aberta. O job é salvo em <code>work/jobs/{job?.id}</code>.</div>}

      <footer><span>EditorIA · protótipo local</span><span>Manifesto JSON primeiro · editor externo opcional</span></footer>
    </main>
  );
}
