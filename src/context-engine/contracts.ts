export interface ContextScope {
  tenantId: string;
  principalId: string;
  projectId: string;
  taskId: string;
  invocationId: string;
  sessionId: string;
  policyVersion: string;
  sourceSnapshot: string;
}
export interface ProtectedContext {
  objective: string;
  acceptanceCriteria: string[];
  policy: string;
  permissions: string[];
  checkpoint: string;
}
export interface ContextEvidence {
  id: string;
  sourceUri: string;
  sourceVersion: string;
  contentDigest: string;
  content: string;
  compressible: boolean;
}
export interface OptimizationInput {
  schemaVersion: 1;
  scope: ContextScope;
  protected: ProtectedContext;
  evidence: ContextEvidence[];
  budget: { maxBytes: number; maxTokens?: number };
  expiresAt: number;
}
export interface EvidenceView {
  id: string;
  sourceUri: string;
  sourceVersion: string;
  originalDigest: string;
  contentDigest: string;
  content: string;
  originalReference: string;
  mode: 'original' | 'compressed' | 'fallback';
}
export interface AgentContextView {
  schemaVersion: 1;
  scope: ContextScope;
  protected: ProtectedContext;
  evidence: EvidenceView[];
  canonicalPacketDigest: string;
}
export interface OptimizationResult {
  view: AgentContextView;
  viewDigest: string;
  optimizerId: string;
  beforeBytes: number;
  afterBytes: number;
  authorizationReceipts: string[];
  warnings: string[];
}
export interface ContextOptimizer {
  optimize(input: OptimizationInput, signal?: AbortSignal): Promise<OptimizationResult>;
  recover(scope: ContextScope, reference: string, signal?: AbortSignal): Promise<ContextEvidence>;
}
export interface EvidenceAccess {
  phase: 'read' | 'compress' | 'pack' | 'recover';
  scope: ContextScope;
  evidence: readonly { id: string; contentDigest: string; sourceUri: string; sourceVersion: string; compressible: boolean }[];
}
/** Host-owned authorization port, not a model-supplied boolean or fake action receipt. */
export interface EvidenceAuthority {
  authorize(access: EvidenceAccess, signal?: AbortSignal): Promise<{ allowed: boolean; receiptId: string }>;
}
export interface NetworkIntent {
  scope: ContextScope;
  endpoint: string;
  bodyDigest: string;
  evidenceId: string;
}
/** Host must reserve/check the exact action, persist receipts and recheck after await. */
export interface NetworkExecutor {
  execute<T>(intent: NetworkIntent, operation: () => Promise<T>, signal: AbortSignal): Promise<{ value: T; receiptId: string }>;
}
export interface TokenCounter {
  id: string;
  count(serializedView: string): number;
}
export class ContextBoundaryError extends Error {
  constructor(readonly code: 'invalid-input' | 'denied' | 'expired' | 'cancelled' | 'budget-exceeded' | 'original-unavailable') {
    super(code);
    this.name = 'ContextBoundaryError';
  }
}
export class CompressionUnavailable extends Error {
  constructor() { super('compression-unavailable'); this.name = 'CompressionUnavailable'; }
}
