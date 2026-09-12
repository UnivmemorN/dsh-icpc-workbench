/**
 * Hashing primitives for content-addressed domain state.
 *
 * A pure domain may not do IO, but it may depend on a maintained, pure, portable library
 * (`@noble/hashes`, pinned to an exact version and audited by the architecture check).
 * Snapshots therefore carry a real, standard SHA-256 digest instead of a hand-written
 * cipher: "the input changed" and "this stored analysis is stale" stay verifiable facts.
 *
 * `node:crypto` is deliberately not used — it is platform IO, and the same code must run in
 * the plugin host, in tests and in the browser build.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DomainError } from './errors.js';

const TEXT_ENCODER = new TextEncoder();

/**
 * UTF-8 encode a string with the platform's standard encoder.
 * Lone surrogates become U+FFFD, exactly as `TextEncoder` specifies everywhere.
 */
export function utf8Bytes(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

/** SHA-256 of a string (UTF-8) or byte array, as lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8Bytes(input) : input));
}

/** JSON value subset accepted by {@link canonicalJson}. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deterministic JSON encoding: object keys are sorted, `undefined` members are dropped,
 * array order is preserved. Two structurally equal values always encode identically,
 * which is what makes content hashes comparable across processes and restarts.
 */
export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new DomainError('non_serializable_content', `non-finite number at ${path}`, { path });
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new DomainError('non_serializable_content', `undefined value at ${path}`, { path });
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item, index) => {
          if (item === undefined) {
            throw new DomainError('non_serializable_content', `undefined array item at ${path}[${index}]`, {
              path: `${path}[${index}]`,
            });
          }
          return canonicalJson(item, `${path}[${index}]`);
        });
        return `[${items.join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new DomainError('non_serializable_content', `unsupported ${typeof value} at ${path}`, { path });
  }
}

/** SHA-256 over the canonical JSON form of `value`. Stable across key order and platforms. */
export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
