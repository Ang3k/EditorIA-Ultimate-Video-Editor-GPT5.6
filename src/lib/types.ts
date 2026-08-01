export type JobStatus =
  | "received"
  | "transcribing"
  | "awaiting_direction"
  | "planning"
  | "searching"
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
  queries: string[];
  mustShow: string[];
  confidence: number;
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
  thumbnailUrl?: string;
}

export interface PlannedClip {
  unitId: string;
  candidateId: string | null;
  sourceStart: number;
  duration: number;
  confidence: number;
  rationale: string;
}

export interface EditPlan {
  title: string;
  visualStyle: string;
  clips: PlannedClip[];
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

export interface TimelineSegment {
  unitId: string;
  fileName: string;
  duration: number;
  sourceUrl?: string;
  sourceTitle?: string;
}

export type EditorTrackKind = "video" | "audio";

export interface EditorTrack {
  id: "V2" | "V1" | "A1";
  kind: EditorTrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
}

export interface EditorClip {
  id: string;
  trackId: EditorTrack["id"];
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
}

export interface EditorProject {
  version: 1;
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
  creativeBrief?: CreativeBrief;
  duration?: number;
  transcript?: TranscriptDocument;
  visualUnits?: VisualUnit[];
  candidates?: YouTubeCandidate[];
  editPlan?: EditPlan;
  timeline?: TimelineSegment[];
  editorProject?: EditorProject;
  media?: JobMedia;
  error?: string;
}
