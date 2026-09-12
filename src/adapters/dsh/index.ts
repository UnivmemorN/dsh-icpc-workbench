/** dsh host adapters: the audited auxiliary model client and the tag-model gateway. */
export {
  AUDITED_MODEL_ROLES,
  AUDIT_CONTEXT_FRAMING_MARGIN_TOKENS,
  DshAuditedModelClient,
  MAX_AUDIT_MAX_TOKENS,
  MAX_AUDIT_PROMPT_BYTES,
  MAX_AUDIT_STREAM_BYTES,
  MAX_AUDIT_STREAM_CHUNKS,
  MAX_AUDIT_TIMEOUT_MS,
  MIN_AUDIT_MAX_TOKENS,
} from './audited-client.js';
export type {
  AuditedJson,
  AuditedJsonCallRequest,
  AuditedModelRole,
  AuditedJsonObject,
  DshAuditedHost,
  IcpcModelCallAudit,
  IcpcModelCallResultAudit,
} from './audited-client.js';

export {
  ANALYZE_SYSTEM_PROMPT,
  DshModelGateway,
  MODEL_GATEWAY_MAX_CONCURRENCY,
  REASON_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
} from './model-gateway.js';
export type { DshModelGatewayClient, DshModelGatewayOptions } from './model-gateway.js';

export {
  MAX_ANALYSIS_SUGGESTIONS,
  MAX_CONFLICTING_SOLUTIONS,
  MAX_EVIDENCE_PER_SUGGESTION,
  MAX_EXCERPT_CHARS,
  MAX_NOTE_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_REASON_DRAFTS,
  MAX_TAXONOMY_IDS_PER_DRAFT,
  ModelOutputError,
  parseAnalyzeOutput,
  parseReasoningOutput,
  parseVerificationOutput,
  shownSolution,
} from './model-output.js';
export type { AnalyzeOutputContext, ReasonOutputContext, VerifyOutputContext } from './model-output.js';
