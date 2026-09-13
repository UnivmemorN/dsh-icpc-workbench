/**
 * Luogu authenticated submission-history port (Sprint 17a).
 *
 * This module is the seam between the application/plugin layers and an authenticated Luogu
 * submission reader. It carries **only normalized page inputs and results**: one account, an
 * opaque continuation cursor, an exact row limit, an inclusive `since` bound, explicit platform
 * limits and a cancellation token in; a domain `Page<Submission>` (or a typed platform failure)
 * out.
 *
 * Credentials are deliberately not representable here. A Luogu session cookie lives entirely
 * behind the adapter implementation (`adapters/luogu`): it is never a field of this port, never
 * part of a cursor, never echoed in a result and never placed in an error, so no caller of this
 * port — UI, plugin, storage or model code — can leak it. The injectable OS credential provider
 * that produces a session is defined in the adapter layer as well.
 */
import type { Submission } from '../domain/index.js';
import type { ListSubmissionsRequest, Page } from './ports.js';

/**
 * Authenticated Luogu submission history for one account.
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
 *   oversized body, changed shape) instead of an empty page.
 *
 * The request/result shape is intentionally the same as {@link PlatformAdapter.listSubmissions},
 * so an implementation can be injected into `LuoguAdapter` and driven by `ImportService.syncPage`
 * without an adapter-specific wrapper.
 */
export interface LuoguSessionReader {
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
}
