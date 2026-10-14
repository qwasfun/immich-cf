param([ValidateRange(1,10)][int]$IncrementalSamples=1)
# Only dev, a bounded sequential probe, and a temporary session. Never print credentials.
$ErrorActionPreference='Stop'
$base='https://immich-cf-api-dev.fun.workers.dev'
$account=Get-Content (Join-Path $PSScriptRoot '../work/dev-account.json') -Raw | ConvertFrom-Json
$run=[Guid]::NewGuid().ToString()
$started=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$steps=[Collections.Generic.List[object]]::new()
$token=$null
function Invoke-Probe([string]$name,[string]$path,[string]$method='GET',$body=$null,[int]$expected=200) {
  $params=@{Uri="$base${path}?budgetRun=$run";Method=$method;TimeoutSec=30;SkipHttpErrorCheck=$true}
  if($token){$params.Headers=@{Authorization="Bearer $token"}}
  if($null -ne $body){$params.ContentType='application/json';$params.Body=$body|ConvertTo-Json -Depth 8 -Compress}
  $r=Invoke-WebRequest @params
  $steps.Add(@{name=$name;status=[int]$r.StatusCode;requestId=([string]$r.Headers['cf-ray']).Split('-')[0]})
  if($r.StatusCode -ne $expected){throw "Probe $name expected $expected got $($r.StatusCode)"}
  return $r
}
try {
  $null=Invoke-Probe 'health' '/healthz'
  $login=Invoke-Probe 'login-success' '/api/auth/login' 'POST' @{email=$account.email;password=$account.password} 201
  $token=($login.Content|ConvertFrom-Json).accessToken
  $null=Invoke-Probe 'login-wrong-password' '/api/auth/login' 'POST' @{email=$account.email;password='budget-probe-incorrect-password'} 401
  $null=Invoke-Probe 'login-unknown-user' '/api/auth/login' 'POST' @{email="budget-$run@immich-cf.test";password='budget-probe-incorrect-password'} 401
  $null=Invoke-Probe 'user' '/api/users/me'
  $sync=Invoke-Probe 'snapshot' '/api/sync/stream' 'POST' @{types=@('AuthUsersV2','UsersV1','AssetsV2','AssetMetadataV1');reset=$true}
  $text=if($sync.Content -is [byte[]]){[Text.Encoding]::UTF8.GetString($sync.Content)}else{$sync.Content}
  $events=@($text.Trim().Split("`n")|ForEach-Object {$_|ConvertFrom-Json})
  if($events[-1].type -ne 'SyncCompleteV1'){throw 'Incomplete snapshot'}
  $null=Invoke-Probe 'ack' '/api/sync/ack' 'POST' @{acks=@($events.ack)} 204
  for($sample=1;$sample -le $IncrementalSamples;$sample++) {
    $name=if($IncrementalSamples -eq 1){'incremental'}else{"incremental-$sample"}
    $incremental=Invoke-Probe $name '/api/sync/stream' 'POST' @{types=@('AuthUsersV2','UsersV1','AssetsV2','AssetMetadataV1')}
    $text=if($incremental.Content -is [byte[]]){[Text.Encoding]::UTF8.GetString($incremental.Content)}else{$incremental.Content}
    $events=@($text.Trim().Split("`n")|ForEach-Object {$_|ConvertFrom-Json})
    if($events.Count -ne 1 -or $events[0].type -ne 'SyncCompleteV1'){throw 'Incremental snapshot is not empty'}
  }
} finally {
  try { if($token){$null=Invoke-Probe 'logout' '/api/auth/logout' 'POST' @{}} } finally {
  @{run=$run;from=$started;to=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();steps=$steps.ToArray()}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $PSScriptRoot '../work/budget-probe.json')
}
}
Write-Output 'dev probe complete; sanitized run metadata saved to work/budget-probe.json'
