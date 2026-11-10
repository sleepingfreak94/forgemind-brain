export interface WorkflowPreferences {
  askAt: 'project' | 'task';
  draftPr?: boolean;
  evidence?: 'text' | 'video' | 'both';
  planReview?: 'approve' | 'show' | 'auto';
}
export type TaskPreferences = Omit<WorkflowPreferences, 'askAt'>;
export interface ProjectProfile {
  schemaVersion: 1;
  projectId: string;
  name: string;
  documents: { prd: string; srs: string; adrs: string };
  preferences: WorkflowPreferences;
}
export interface ImplementationPlan {
  schemaVersion: 1;
  objective: string;
  changedPaths: string[];
  steps: string[];
  acceptanceCriteria: string[];
  checks: string[];
  risks: string[];
  rollback: string;
}
/** Supplied by the trusted host, never inferred from a retrieved document. */
export interface WorkflowScope {
  projectId: string; taskId: string; principalId: string;
  workspaceRoot: string; sourceSnapshot: string; expiresAt: number;
}
export interface WorkflowProofRequest {
  kind: 'plan-review' | 'before-video';
  scope: WorkflowScope;
  planDigest: string;
  preferencesDigest: string;
}
/** Verify opaque owner-issued receipts / actual pre-edit recording evidence. */
export interface WorkflowAuthority {
  verify(request: WorkflowProofRequest, receiptId: string): Promise<boolean>;
}
export type WorkflowStatus = 'needs-preferences' | 'needs-task-preferences' | 'needs-plan-approval' | 'needs-before-video' | 'ready-for-policy';
export interface WorkflowPreparation {
  profile: ProjectProfile; plan: ImplementationPlan; scope: WorkflowScope;
  preferences: TaskPreferences; overrides: TaskPreferences; planDigest: string; preferencesDigest: string;
  missingPreferences: string[]; taskPreferencesConfirmed: boolean;
  deliverables: string[];
  memory?: MemoryPacket;
}
export interface WorkflowResult {
  status: WorkflowStatus;
  liveCodingEnabled: false;
  receiptIds: string[];
}
import type { MemoryPacket } from '../memory/contracts.js';
