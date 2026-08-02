export type JobStatus =
  | "received"
  | "transcribing"
  | "awaiting_direction"
  | "planning"
  | "searching"
  | "verifying"
  | "downloading"
  | "rendering"
  | "awaiting_approval"
  | "exporting"
  | "completed"
  | "failed";

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptDocument {
  text: string;
  duration: number;
  language?: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
}

export interface VisualUnit {
  id: string;
  start: number;
  end: number;
  narration: string;
  visualBrief: string;
  subject?: string;
  action?: string;
  location?: string;
  queries: string[];
  mustShow: string[];
  mustAvoid?: string[];
  confidence: number;
}

export interface VisualPlan {
  baseQuery: string;
  baseMustShow: string[];
  units: VisualUnit[];
}

export type CandidateSourceKind = "raw_gameplay" | "cutscene" | "official_footage" | "edited_creator" | "unknown";

export interface CandidateVerification {
  status: "approved" | "rejected";
  directMatchScore: number;
  rawFootage: boolean;
  editedCreatorRisk: boolean;
  blackFrameRisk: boolean;
  sourceKind: CandidateSourceKind;
  evidence: string[];
  rejectionReason?: string;
  checkedAt: string;
}

export interface YouTubeCandidate {
  id: string;
  unitId: string;
  query: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
  duration?: number;
  sourceKind?: CandidateSourceKind;
  thumbnailUrl?: string;
  verification?: CandidateVerification;
}

export interface PlannedClip {
  unitId: string;
  candidateId: string | null;
  candidateIds: string[];
  sourceStart: number;
  duration: number;
  confidence: number;
  rationale: string;
}

export interface EditPlan {
  title: string;
  visualStyle: string;
  baseQuery: string;
  baseCandidateIds: string[];
  clips: PlannedClip[];
}

export interface BaseCoverage {
  fileName: string;
  duration: number;
  sourceStart?: number;
  candidateId: string;
  sourceUrl: string;
  sourceTitle: string;
  coverage: "source";
}

export type CreativeQuestionKind = "single" | "multi" | "text";

export interface CreativeQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface CreativeQuestion {
  id: string;
  kind: CreativeQuestionKind;
  eyebrow?: string;
  question: string;
  helper?: string;
  options?: CreativeQuestionOption[];
  placeholder?: string;
  required?: boolean;
  maxSelections?: number;
}

export interface CreativeBrief {
  questions: CreativeQuestion[];
  answers: Record<string, string | string[]>;
  submittedAt?: string;
}

export interface AiRuntimeInfo {
  provider: "codex-cli";
  model: string;
  reasoningEffort: string;
  label: string;
}

export interface TimelineSegment {
  unitId: string;
  fileName: string;
  duration: number;
  sourceUrl?: string;
  sourceTitle?: string;
  coverage: "source";
  candidateId?: string;
}

export function isGapUnitId(unitId: string | undefined | null) {
  return Boolean(unitId?.startsWith("gap-"));
}

export type EditorTrackKind = "video" | "audio";

export interface EditorTrack {
  id: "V2" | "V1" | "A1";
  kind: EditorTrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
}

export type EditorClipRole = "base" | "contextual" | "audio";

export interface EditorClip {
  id: string;
  trackId: EditorTrack["id"];
  role?: EditorClipRole;
  unitId?: string;
  assetType: EditorTrackKind;
  assetFileName?: string;
  label: string;
  start: number;
  duration: number;
  sourceStart: number;
  sourceDuration: number;
  sourceUrl?: string;
  sourceTitle?: string;
  coverage?: "source";
}

export interface EditorProject {
  version: 2;
  title: string;
  width: 1920;
  height: 1080;
  fps: 30;
  duration: number;
  tracks: EditorTrack[];
  clips: EditorClip[];
}

export interface JobMedia {
  preview?: string;
  final?: string;
}

export interface JobState {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  originalAudioName: string;
  audioFileName: string;
  brief: string;
  ai?: AiRuntimeInfo;
  creativeBrief?: CreativeBrief;
  duration?: number;
  transcript?: TranscriptDocument;
  visualPlan?: VisualPlan;
  visualUnits?: VisualUnit[];
  candidates?: YouTubeCandidate[];
  editPlan?: EditPlan;
  baseCoverage?: BaseCoverage;
  timeline?: TimelineSegment[];
  editorProject?: EditorProject;
  media?: JobMedia;
  error?: string;
}
