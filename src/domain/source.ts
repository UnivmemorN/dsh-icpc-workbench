/**
 * Source instances and accounts.
 *
 * A source instance is one concrete, addressable deployment of a platform
 * (`codeforces` on codeforces.com, a self-hosted `hydro` domain, the local `manual`
 * source). Problems, submissions and snapshots are always scoped to an instance, so
 * mirrored or self-hosted deployments can never collide.
 *
 * Accounts never carry credentials: cookies/tokens belong to the adapter configuration
 * (plugin layer) and are deliberately not representable in the domain.
 */
import { DomainError, invariant } from './errors.js';
import {
  INSTANCE_SEPARATOR,
  accountIdOf,
  assertHttpUrl,
  assertIdPart,
  encodeIdPart,
  type SourcePlatform,
} from './ids.js';
import { deepFreeze } from './immutable.js';

/** One addressable source instance. */
export interface SourceInstance {
  /** Stable id: `platform:domain` with the domain escaped. Derived, never random. */
  readonly id: string;
  readonly platform: SourcePlatform;
  /** Base URL for user-facing links and adapter requests (absolute http(s)). */
  readonly baseUrl: string;
  /** Optional domain override (mirror/self-hosted host, e.g. `hydro.example.edu`). */
  readonly domain: string | null;
  readonly displayName: string;
}

export interface CreateSourceInstanceInput {
  readonly platform: SourcePlatform;
  /** Absolute http(s) base URL. */
  readonly baseUrl: string;
  /** Optional domain; defaults to the host of `baseUrl`. */
  readonly domain?: string | null;
  readonly displayName?: string;
}

/**
 * Derive the stable instance id from platform + domain.
 *
 * The domain is lowercased (hosts are case-insensitive) and escaped as one component, so a
 * self-hosted deployment with a port (`localhost:8080`) or a mirror host is representable.
 * The id stays opaque to problem/account/submission keys, which escape it again.
 */
export function sourceInstanceIdOf(platform: SourcePlatform, domain: string): string {
  assertIdPart('platform', platform);
  invariant(typeof domain === 'string', 'invalid_input', 'domain must be a string', { domain });
  const normalizedDomain = domain.trim().toLowerCase().normalize('NFC');
  invariant(normalizedDomain.length > 0, 'invalid_input', 'domain must not be empty', { domain });
  return `${platform}${INSTANCE_SEPARATOR}${encodeIdPart(normalizedDomain)}`;
}

/** Build a validated, frozen source instance. */
export function createSourceInstance(input: CreateSourceInstanceInput): SourceInstance {
  const baseUrl = assertHttpUrl('baseUrl', input.baseUrl);
  const host = new URL(baseUrl).host.toLowerCase();
  const domain = (input.domain ?? host).trim().toLowerCase();
  invariant(domain.length > 0, 'invalid_input', 'domain must not be empty', { domain });
  return deepFreeze({
    id: sourceInstanceIdOf(input.platform, domain),
    platform: input.platform,
    baseUrl,
    domain,
    displayName: input.displayName?.trim() || `${input.platform} (${domain})`,
  });
}

/** A personal account on one source instance. Handle is the external identity. */
export interface Account {
  /** Stable id `sourceInstanceId|handle`; both components escaped via `encodeIdPart`. */
  readonly id: string;
  readonly sourceInstanceId: string;
  readonly handle: string;
  readonly displayName: string | null;
  /** Optional link to the profile page (http(s) only). */
  readonly profileUrl: string | null;
}

export interface CreateAccountInput {
  readonly sourceInstanceId: string;
  readonly handle: string;
  readonly displayName?: string | null;
  readonly profileUrl?: string | null;
}

/** Build a validated, frozen account. */
export function createAccount(input: CreateAccountInput): Account {
  const handle = input.handle.trim();
  invariant(handle.length > 0, 'invalid_input', 'account handle must not be empty', { handle: input.handle });
  return deepFreeze({
    id: accountIdOf(input.sourceInstanceId, handle),
    sourceInstanceId: input.sourceInstanceId,
    handle,
    displayName: input.displayName?.trim() || null,
    profileUrl: input.profileUrl ? assertHttpUrl('profileUrl', input.profileUrl) : null,
  });
}

/** Compare two accounts by stable id. */
export function sameAccount(left: Pick<Account, 'id'>, right: Pick<Account, 'id'>): boolean {
  return left.id === right.id;
}

/** Guard for account references coming from persisted state. */
export function requireAccount(account: Account | null | undefined, context: string): Account {
  if (!account) {
    throw new DomainError('missing_reference', `account is required for ${context}`, { context });
  }
  return account;
}
