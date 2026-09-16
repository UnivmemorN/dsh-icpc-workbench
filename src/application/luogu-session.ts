/**
 * Luogu authenticated submission-history and editorial port (Sprint 17a; editorial added in 33C).
 *
 * This module is the seam between the application/plugin layers and an authenticated Luogu reader. It
 * carries **only normalized inputs and results**: one account, an opaque continuation cursor, an exact
 * row limit, an inclusive `since` bound, explicit platform limits and a cancellation token in; a
 * domain `Page<Submission>` (or a typed platform failure) out. The editorial member carries the
 * problem reference and the same token/limits, and answers with a normalized
 * {@link EditorialFetchResult}.
 *
 * Credentials are deliberately not representable here. A Luogu session cookie lives entirely
 * behind the adapter implementation (`adapters/luogu`): it is never a field of this port, never
 * part of a cursor, never echoed in a result and never placed in an error, so no caller of this
 * port — UI, plugin, storage or model code — can leak it. The injectable OS credential provider
 * that produces a session is defined in the adapter layer as well.
 */
import type { Account, ProblemRef, Submission } from '../domain/index.js';
import type { EditorialFetchResult, ListSubmissionsRequest, Page, PlatformLimits } from './ports.js';
import type { CancellationToken } from '../domain/index.js';

/** One authenticated editorial read of exactly one problem, for exactly one account. */
export interface LuoguEditorialRequest {
  /** The account whose session is used. It must be a canonical Luogu UID of this instance. */
  readonly account: Account;
  /** The problem to read the solution material of. */
  readonly problemRef: ProblemRef;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
  /**
   * Optional caller-supplied editorial URL, validated by the implementation against its own official
   * origin before any request. Luogu's own solution list is addressed by problem id, so an
   * implementation that cannot honour a supplied URL must refuse it rather than ignore it.
   */
  readonly officialTutorialUrl?: string | null;
}

/**
 * Authenticated Luogu submission history and editorial material for one account.
 *
 * Implementations must:
 * - verify the account is a canonical Luogu UID on the adapter's own source instance *before*
 *   any request, and authenticate as exactly that account;
 * - never return a record whose exposed identity is not the requested account's;
 * - honour `since` inclusively, `limit` exactly (never more rows than requested) and the
 *   caller's cancellation token;
 * - return `nextCursor: null` only when the page really exhausted the requested window, so a
 *   checkpoint is never marked complete by a partial scan;
 * - raise typed platform failures (authentication expiry, HTML/challenge, rate limit, timeout,
 *   oversized body, changed shape) instead of an empty page;
 * - for {@link fetchEditorial}, report `absent` **only** when the platform explicitly said there is
 *   no solution material, and report every unreadable or refused answer as a typed failure. A broken
 *   request must never be disguised as "no editorial exists", because that answer starts the
 *   statement-only reasoning path.
 *
 * The submission request/result shape is intentionally the same as
 * {@link PlatformAdapter.listSubmissions}, so an implementation can be injected into `LuoguAdapter`
 * and driven by `ImportService.syncPage` without an adapter-specific wrapper.
 */
export interface LuoguSessionReader {
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
  /** Read one problem's solution material through the account's session. */
  fetchEditorial(request: LuoguEditorialRequest): Promise<EditorialFetchResult>;
}
