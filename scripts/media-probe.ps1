$ErrorActionPreference='Stop'
$base='https://immich-cf-api-dev.fun.workers.dev'
$account=Get-Content (Join-Path $PSScriptRoot '../work/dev-account.json') -Raw | ConvertFrom-Json
$headers=@{}
function Call-Media($path,$method='GET',$data=$null,$extra=@{}) {
  $h=@{}; foreach($k in $headers.Keys){$h[$k]=$headers[$k]}; foreach($k in $extra.Keys){$h[$k]=$extra[$k]}
  $p=@{Uri="$base$path";Method=$method;Headers=$h;TimeoutSec=30;SkipHttpErrorCheck=$true}
  if($null -ne $data){$p.ContentType='application/json';$p.Body=$data|ConvertTo-Json -Depth 5 -Compress}
  for($attempt=0;$attempt -lt 3;$attempt++) {
    try { return Invoke-WebRequest @p } catch {
      # Retry only safe reads and idempotent logout, never replay a login with unknown outcome.
      if(($method -ne 'GET' -and $method -ne 'HEAD' -and $path -ne '/api/auth/logout') -or $attempt -eq 2){throw}
      Start-Sleep -Seconds 1
    }
  }
}
try {
  $login=Call-Media '/api/auth/login' 'POST' @{email=$account.email;password=$account.password}
  if($login.StatusCode -ne 201){throw 'Login failed'}
  $headers.Authorization='Bearer '+($login.Content|ConvertFrom-Json).accessToken
  $sync=Call-Media '/api/sync/stream' 'POST' @{types=@('UsersV1','AssetsV2')}
  if($sync.StatusCode -ne 200){throw 'Sync failed'}
  $text=if($sync.Content -is [byte[]]){[Text.Encoding]::UTF8.GetString($sync.Content)}else{$sync.Content}
  $asset=$text.Trim().Split("`n")|ForEach-Object {$_|ConvertFrom-Json}|Where-Object {$_.type -eq 'AssetV2'}|Select-Object -First 1
  if(!$asset){throw 'Nonempty dev library required'}
  $path='/api/assets/'+$asset.data.id+'/original'
  $full=Call-Media $path
  if($full.StatusCode -ne 200 -or $full.Content -isnot [byte[]]){throw 'Original read failed'}
  $etag=[string]$full.Headers.ETag
  $part=Call-Media $path 'GET' $null @{Range='bytes=0-7'}
  if($part.StatusCode -ne 206 -or [Convert]::ToBase64String($part.Content) -ne [Convert]::ToBase64String($full.Content[0..7])){throw 'Range bytes mismatch'}
  $head=Call-Media $path 'HEAD'
  if($head.StatusCode -ne 200 -or [string]$head.Headers['Content-Length'] -ne [string]$full.Content.Length){throw 'HEAD mismatch'}
  $cached=Call-Media $path 'GET' $null @{'If-None-Match'=$etag}
  if($cached.StatusCode -ne 304){throw 'ETag mismatch'}
  $invalid=Call-Media $path 'GET' $null @{Range=('bytes='+$full.Content.Length+'-')}
  if($invalid.StatusCode -ne 416){throw 'Range boundary mismatch'}
  $logout=Call-Media '/api/auth/logout' 'POST' @{}
  if($logout.StatusCode -ne 200){throw 'Logout failed'}
  $revoked=Call-Media $path 'GET' $null @{'If-None-Match'=$etag}
  if($revoked.StatusCode -ne 401){throw 'Revoked session accepted'}
  $headers=@{}
  @{checkedAt=[DateTimeOffset]::UtcNow.ToString('o');original=200;range=206;bytesMatch=$true;head=200;etag=304;unsatisfiable=416;revoked=401}|ConvertTo-Json|Set-Content (Join-Path $PSScriptRoot '../work/media-probe.json')
  Write-Output 'dev media probe passed; sanitized report saved'
} finally {
  if($headers.Authorization){$null=Call-Media '/api/auth/logout' 'POST' @{}}
}
