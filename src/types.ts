export interface Profile {
  version: 1;
  context: string[];
  roles: Record<string, string>;
  commands: Record<string, { argv: string[]; cwd: string; timeoutMs: number }>;
  policy: { maxWorkers: number; leaseMs: number; sensitivePaths: string[] };
  plan?: string;
}
export interface WorkerIdentity { host: 'codex' | 'opencode' | 'manual'; sessionId: string; workerId: string; role: string }
export interface TaskInput {
  id: string; title: string; requirement: string; acceptance: string[]; dependencies: string[];
  scope: string[]; requiredChecks: string[]; risk?: 'normal' | 'sensitive'; code?: boolean; sourceRefs?: string[];
}
export interface TaskRecord extends TaskInput {
  status: string; claim?: ClaimRecord; candidate?: CandidateSnapshot; warnings?: string[];
  verified?: boolean; integrated?: boolean; imported?: boolean;
  approvalValid?: boolean; validationReason?: string;
}
export interface ClaimRecord { token: string; taskId: string; worker: WorkerIdentity; expiresAt: number; worktree?: string; baseCommit?: string }
export interface CandidateSnapshot { baseCommit: string; headCommit: string; treeHash: string; diffHash: string; files: string[]; worktree: string }
export interface EvidenceInput {
  checkId: string; exitCode: number | null; passed: boolean; treeHash: string; diffHash: string;
  artifact: string; artifactHash: string; startedAt: number; finishedAt: number;
}
export interface ReviewInput {
  verdict: 'pass' | 'fail'; kind: 'spec' | 'code' | 'security'; treeHash: string; diffHash: string;
  criteria: string[]; findings: { severity: 'critical' | 'high' | 'medium' | 'low'; message: string; resolved: boolean }[];
}
export interface Approval { profileHash: string; planFile: string; planHash: string; contextHash: string; approvedAt: number; approvalId?: string }
export interface ExternalGateInput { id: string; dimension: 'staging' | 'release'; passed: boolean; evidenceRef: string; artifactHash: string; owner: string; taskIds?: string[] }
