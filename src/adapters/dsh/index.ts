/** dsh host adapters; Stage 4a1 exports the audited auxiliary model client only. */
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
