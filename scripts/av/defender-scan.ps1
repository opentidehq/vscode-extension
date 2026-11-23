# Microsoft Defender for the antivirus gate (.github/workflows/av-gate.yml, docs/RELEASING.md "The antivirus gate").
#   pwsh scripts/av/defender-scan.ps1 -Packages <folder of .vsix> -Extracted <folder of extracted packages>
# Exit 0: the canary was detected and every target was scanned and found clean. Exit 2: anything else.
#
# What opentide learnt (opentide#1752): on GitHub's Windows images Defender can report "clean" while scanning
# nothing. The images exclude C:\ and D:\ (where the artifacts are) and may run with real-time protection off.
# So: the exclusions are removed first, and a scan only counts once an EICAR canary, put together at run time,
# is detected. Each verdict is read from MpCmdRun's own output; output that says neither "no threats" nor
# "N threats" fails. Messages are printed and the script exits 2 itself: under ErrorActionPreference Stop,
# Write-Error would throw before the exit.
param(
  [Parameter(Mandatory = $true)][string]$Packages,
  [Parameter(Mandatory = $true)][string]$Extracted
)
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host "::error title=AV gate::Defender: $message"
  exit 2
}

# MpCmdRun: the platform's own copy, else the newest one the platform updates installed.
$mp = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
if (-not (Test-Path -LiteralPath $mp)) {
  $platform = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
  $mp = Get-ChildItem -Path $platform -Filter MpCmdRun.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Name -replace '-.*$', '') } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $mp -or -not (Test-Path -LiteralPath $mp)) { Fail 'MpCmdRun.exe was not found' }
Write-Host "MpCmdRun: $mp"

# The runner's preferences, then no exclusions, archive scanning on, nothing sent to Microsoft.
$pref = Get-MpPreference
$pref | Format-List ExclusionPath, ExclusionExtension, ExclusionProcess, DisableRealtimeMonitoring, DisableArchiveScanning, MAPSReporting, SubmitSamplesConsent
if ($pref.ExclusionPath) { Remove-MpPreference -ExclusionPath $pref.ExclusionPath }
if ($pref.ExclusionExtension) { Remove-MpPreference -ExclusionExtension $pref.ExclusionExtension }
if ($pref.ExclusionProcess) { Remove-MpPreference -ExclusionProcess $pref.ExclusionProcess }
Set-MpPreference -DisableArchiveScanning $false -SubmitSamplesConsent 2
$after = Get-MpPreference
if ($after.ExclusionPath) { Fail "path exclusions remain: $($after.ExclusionPath -join ', ')" }
Write-Host "exclusions removed; SubmitSamplesConsent $($after.SubmitSamplesConsent) (2: never send)"

# Fresh signatures, or no scan.
$updated = $false
foreach ($attempt in 1..3) {
  & $mp -SignatureUpdate | Out-Host
  if ($LASTEXITCODE -eq 0) { $updated = $true; break }
  Start-Sleep -Seconds (20 * $attempt)
}
if (-not $updated) { Fail 'the signatures could not be updated' }
$status = Get-MpComputerStatus
$status | Format-List AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AMEngineVersion, AntivirusSignatureVersion, AntivirusSignatureLastUpdated
if (-not $status.AntivirusEnabled) { Fail 'the antivirus is not enabled' }
$age = (Get-Date) - $status.AntivirusSignatureLastUpdated
if ($age.TotalHours -gt 48) { Fail "the signatures are $([int]$age.TotalHours) hours old" }

# One scan: 'clean', 'detected' (with the threat names) or 'unreadable' (the output said neither).
function Scan([string]$target) {
  $output = (& $mp -Scan -ScanType 3 -File $target -DisableRemediation 2>&1 | Out-String)
  $exit = $LASTEXITCODE
  $names = @([regex]::Matches($output, '(?m)^\s*Threat\s*:\s*(.+?)\s*$') | ForEach-Object { $_.Groups[1].Value })
  $count = [regex]::Match($output, 'found (\d+) threats?')
  if ($count.Success -and [int]$count.Groups[1].Value -ge 1) {
    return @{ verdict = 'detected'; names = $names; output = $output; exit = $exit }
  }
  if ($output -match 'found no threats') { return @{ verdict = 'clean'; names = @(); output = $output; exit = $exit } }
  return @{ verdict = 'unreadable'; names = @(); output = $output; exit = $exit }
}

# The canary decides whether a scan counts. The EICAR test string, from two halves: no file holds it whole.
$canaryDir = Join-Path $env:RUNNER_TEMP ("defender-canary-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $canaryDir | Out-Null
$canary = Join-Path $canaryDir 'canary.com'
$text = 'X5O!P%@AP[4\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
$refused = $false
try { [IO.File]::WriteAllText($canary, $text, [Text.Encoding]::ASCII) } catch { $refused = $true; Write-Host "the canary's write was refused: $($_.Exception.Message)" }
Start-Sleep -Seconds 2
$vanished = -not (Test-Path -LiteralPath $canary)
$result = Scan $canaryDir
Write-Host $result.output
if ($result.verdict -eq 'detected') {
  Write-Host "canary detected by the scan: $($result.names -join ', ')"
} elseif ($refused -or $vanished) {
  Write-Host 'canary detected by real-time protection (its write was refused, or it vanished)'
} else {
  Fail "Defender is not scanning: the EICAR canary was not detected (verdict $($result.verdict), MpCmdRun exit $($result.exit))"
}
Remove-Item -Recurse -Force $canaryDir -ErrorAction SilentlyContinue

# The targets: each .vsix, each extracted package as a whole, and each .wasm and JavaScript file on its own,
# so a verdict names the file.
$targets = @()
$targets += @(Get-ChildItem -LiteralPath $Packages -Filter *.vsix -File | ForEach-Object FullName)
$targets += @(Get-ChildItem -LiteralPath $Extracted -Directory | ForEach-Object FullName)
$targets += @(Get-ChildItem -LiteralPath $Extracted -Recurse -File |
  Where-Object { $_.Extension -in '.wasm', '.js', '.cjs', '.mjs' } | ForEach-Object FullName)
if (@(Get-ChildItem -LiteralPath $Packages -Filter *.vsix -File).Count -eq 0) { Fail "no .vsix in $Packages" }

$problems = @()
foreach ($target in $targets) {
  $result = Scan $target
  Write-Host "$($result.verdict.ToUpper()): $target"
  if ($result.verdict -eq 'detected') { $problems += "DETECTED $target ($($result.names -join ', '))" }
  if ($result.verdict -eq 'unreadable') {
    Write-Host $result.output
    $problems += "UNREADABLE $target (MpCmdRun exit $($result.exit))"
  }
}

# Anything real-time protection found on the packages' paths, on extraction or during the scans.
$roots = @((Resolve-Path -LiteralPath $Packages).Path, (Resolve-Path -LiteralPath $Extracted).Path)
$found = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object {
  $resources = $_.Resources -join ' '
  @($roots | Where-Object { $resources.Contains($_) }).Count -gt 0
})
if ($found.Count -gt 0) {
  $found | Format-List | Out-Host
  $problems += "detections on the packages' paths (above)"
}

if ($problems.Count -gt 0) { Fail ($problems -join '; ') }
Write-Host "Defender: canary detected; $($targets.Count) targets scanned, all clean"
exit 0
