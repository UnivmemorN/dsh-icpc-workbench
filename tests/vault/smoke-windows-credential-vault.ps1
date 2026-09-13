<#
  Sprint 17b Windows smoke: drives the real frozen bridge program against the real Windows
  Credential Manager over PowerShell's own stdin/stdout pipelines.

  Why this exists: the DSH worker file sandbox denies a Node child process with piped stdio
  (`spawn EPERM`), which is exactly the private channel `PowerShellCredentialBridge` uses, so the
  Node-level roundtrip test is skipped there. This script still exercises the real bridge program,
  the real Credential Manager and the real JSON protocol end to end; only the Node process
  management (spawn, bounded stdout, timeout, kill, drain) is covered by the fake-spawn unit tests.

  Safety: the entry is named `dsh-icpc-workbench.smoke.<random guid>` and is always removed, twice.
  Every value is generated inside this script; nothing existing is read, listed or modified. The
  secret travels only on the child's stdin, never in argv or an environment variable, and only
  secret-free booleans are printed.

  Usage (from the repository root): pwsh -NoProfile -File tests/vault/smoke-windows-credential-vault.ps1
#>
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershell)) {
    Write-Output 'SMOKE FAILED: powershell.exe is not present in the system Windows directory'
    exit 1
}

$moduleUrl = ([uri](Join-Path $repoRoot 'src/adapters/windows/credential-bridge.ts')).AbsoluteUri
$loaderUrl = ([uri](Join-Path $repoRoot 'tests/loader.mjs')).AbsoluteUri
$encoded = & node --experimental-strip-types --import $loaderUrl --input-type=module -e "const m = await import('$moduleUrl'); process.stdout.write(m.POWERSHELL_BRIDGE_COMMAND);"
if ([string]::IsNullOrEmpty($encoded)) {
    Write-Output 'SMOKE FAILED: the bridge program could not be read from the module'
    exit 1
}

function Invoke-Bridge([hashtable]$Request) {
    $json = $Request | ConvertTo-Json -Compress
    $reply = $json | & $powershell -NoProfile -NonInteractive -EncodedCommand $encoded
    return @{ Code = $LASTEXITCODE; Reply = $reply }
}

$target = 'dsh-icpc-workbench.smoke.' + [Guid]::NewGuid().ToString('N')
$absentTarget = $target + '.absent'
$secret = 'synthetic-' + [Guid]::NewGuid().ToString('N') + '-🔑'
$secretBytes = [Text.Encoding]::UTF8.GetBytes($secret)

$writeCode = -1
$readCode = -1
$removeCode = -1
$found = $false
$roundtrip = $false
$absent = $false
$gone = $false
$removeAgain = $false
try {
    $write = Invoke-Bridge @{ op = 'write'; target = $target; blob = [Convert]::ToBase64String($secretBytes) }
    $writeCode = $write.Code
    $read = Invoke-Bridge @{ op = 'read'; target = $target }
    $readCode = $read.Code
    $readReply = $read.Reply | ConvertFrom-Json
    $found = [bool]$readReply.found
    if ($found) {
        $roundtrip = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($readReply.blob)) -eq $secret)
    }
    $missing = Invoke-Bridge @{ op = 'read'; target = $absentTarget }
    $absent = (($missing.Reply | ConvertFrom-Json).found -eq $false)
} finally {
    $remove = Invoke-Bridge @{ op = 'remove'; target = $target }
    $removeCode = $remove.Code
    $after = Invoke-Bridge @{ op = 'read'; target = $target }
    $gone = (($after.Reply | ConvertFrom-Json).found -eq $false)
    $again = Invoke-Bridge @{ op = 'remove'; target = $target }
    $removeAgain = ($again.Code -eq 0 -and $again.Reply -eq '{"ok":true}')
    $leftover = Invoke-Bridge @{ op = 'remove'; target = $absentTarget }
    if ($leftover.Code -ne 0) { $removeAgain = $false }
}

Write-Output "bridge-command-bytes=$($encoded.Length)"
Write-Output "secret-bytes=$($secretBytes.Length) secret-chars=$($secret.Length)"
Write-Output "write-exit=$writeCode read-exit=$readCode remove-exit=$removeCode"
Write-Output "found=$found roundtrip=$roundtrip absent=$absent gone=$gone remove-again=$removeAgain"

if ($writeCode -ne 0 -or $readCode -ne 0 -or $removeCode -ne 0 -or -not $found -or -not $roundtrip -or -not $absent -or -not $gone -or -not $removeAgain) {
    Write-Output 'SMOKE FAILED'
    exit 1
}
Write-Output 'SMOKE OK'
