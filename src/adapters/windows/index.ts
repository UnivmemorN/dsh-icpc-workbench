/**
 * Public surface of the Windows adapter layer (Sprint 17b).
 *
 * The vault is host-side only: the plugin composes it for the credential-consuming adapter, and no
 * export here may be used to build a UI DTO or a model payload. `read` returns secret material.
 */
export {
  CREDENTIAL_TARGET_PREFIX,
  WindowsCredentialVault,
  canonicalCredentialNamespace,
  createWindowsCredentialVault,
  credentialTargetName,
  type WindowsCredentialVaultOptions,
} from './credential-vault.js';

export {
  DEFAULT_BRIDGE_TIMEOUT_MS,
  MAX_BRIDGE_STDERR_BYTES,
  MAX_BRIDGE_STDOUT_BYTES,
  POWERSHELL_BRIDGE_ARGUMENTS,
  POWERSHELL_BRIDGE_COMMAND,
  POWERSHELL_BRIDGE_SCRIPT,
  PowerShellCredentialBridge,
  createPowerShellCredentialBridge,
  type BridgeChildProcess,
  type BridgeReadableStream,
  type BridgeSpawnOptions,
  type BridgeWritableStream,
  type CredentialBridge,
  type CredentialBridgeOperation,
  type CredentialBridgeRequest,
  type CredentialBridgeResult,
  type PowerShellCredentialBridgeOptions,
  type SpawnBridgeProcess,
} from './credential-bridge.js';
