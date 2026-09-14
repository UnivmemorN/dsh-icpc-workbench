import type {AssessmentAttemptView} from './assessment-service.js';
import type {AssessmentModelEvidence} from './assessment-capture.js';
import type {GuidanceSnapshot} from '../domain/guidance.js';
/** Explicit browser projection: host session/call ids and private source snapshots stay internal. */
export type ApiAssessmentView=Pick<AssessmentAttemptView,'requestId'|'status'|'requestedAt'|'expiresAt'|'finishedAt'|'provider'|'model'|'settingsRevision'|'methodIds'|'usage'|'report'|'error'|'settlementFailure'|'verification'>&{
 readonly guidance:GuidanceSnapshot;
 readonly evidence:AssessmentModelEvidence|null;
};
export interface ApiAssessmentHistory {readonly items:readonly ApiAssessmentView[];readonly nextCursor:string|null;}
