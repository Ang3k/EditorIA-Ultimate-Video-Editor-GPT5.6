export type JobStatus =
  | "received"
  | "transcribing"
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

export interface TimelineSegment {
  unitId: string;
  fileName: string;
  duration: number;
  sourceUrl?: string;
  sourceTitle?: string;
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
  duration?: number;
  transcript?: TranscriptDocument;
  visualUnits?: VisualUnit[];
  candidates?: YouTubeCandidate[];
  editPlan?: EditPlan;
  timeline?: TimelineSegment[];
  media?: JobMedia;
  error?: string;
}
