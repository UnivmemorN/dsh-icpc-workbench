/**
 * Shared platform transport layer.
 *
 * Adapters import the transport from here; nothing in this module knows about a specific
 * platform, so Luogu/Hydro implementations can reuse the same paced, cancellable transport.
 */
export {
  DEFAULT_HTTP_LIMITS,
  HARD_MAX_RESPONSE_BYTES,
  HARD_MAX_RETRIES,
  HttpTransport,
  MIN_RESPONSE_BYTES,
  type ClockFn,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
  type HttpLimits,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransportOptions,
  type SetTimerFn,
  type WaitFn,
} from './http.js';
