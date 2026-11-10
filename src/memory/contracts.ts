export type MemoryKind = 'document' | 'decision' | 'fact' | 'lesson' | 'fix';
export type MemoryState = 'candidate' | 'validated' | 'superseded' | 'deleted' | 'expired';
export interface Citation { path: string; sha256: string; status: string }
export interface MemoryInput {
  kind: MemoryKind; title: string; text: string; sources: Citation[];
  expiresAt?: number; supersedes?: string;
}
export interface MemoryRecord extends MemoryInput {
  id: string; digest: string; projectId: string; workspaceRoot: string;
  createdAt: number; state: MemoryState;
}
export interface MemorySummary {
  id: string; digest: string; kind: MemoryKind; state: MemoryState;
  title: string; current: boolean; sources: Citation[]; expiresAt?: number;
}
export interface MemoryHit {
  id: string; digest: string; kind: MemoryKind; title: string; excerpt: string;
  sources: Citation[]; expiresAt?: number;
}
export interface MemoryPacket {
  schemaVersion: 1; projectId: string; workspaceRoot: string; query: string;
  trust: 'evidence-only'; entries: MemoryHit[]; digest: string;
}
export interface DocumentSource extends Citation { title: string; text: string }
