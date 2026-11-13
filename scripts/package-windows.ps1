#Requires -Version 7.0
[CmdletBinding()]
param(
  [string] $OutputDirectory = (Join-Path $PSScriptRoot '../dist'),
  [string] $NodeArchive,
  [scriptblock] $SignLauncher,
  [switch] $UseCommandLauncher
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (!$IsWindows) { throw 'Build the Windows package on Windows.' }
if ($SignLauncher -and $UseCommandLauncher) { throw 'Choose either the command launcher or EXE signing.' }
$repo = Split-Path -Parent $PSScriptRoot
$commit = git -C $repo rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git commit.' }

$nodeVersion = '24.22.3'
$nodeFolder = "node-v$nodeVersion-win-x64"
$nodeZipName = "$nodeFolder.zip"
# SHA-256 from the official Node.js release announcement.
$nodeZipSha256 = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
$archiveName = if ($SignLauncher -or $UseCommandLauncher) { 'ChatKeepsake-Windows-x64.zip' } else { 'ChatKeepsake-Windows-x64-unsigned.zip' }

# Package only committed application files. Local exports and installed helpers stay out of the ZIP.
$appFiles = @(
  'LICENSE', 'licenses', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json',
  'archive.js', 'chat-content.js', 'chat-payments.js', 'discover-wechat.js', 'download-assets.js',
  'export-excel.js', 'launcher.js', 'make-viewer.js', 'media.js', 'payment-ledger.js', 'repair-videos.js', 'repair-voices.js',
  'run-process.js', 'save-attachments.js', 'save-location.js', 'server.js', 'transcribe.py',
  'voice-assets.json', 'voice-runtime.js', 'weflow.js',
  'public', 'viewer', 'demo', 'scripts/wechat-open-databases.ps1'
)
$commandLauncher = '启动 ChatKeepsake.cmd'
$launcherFiles = @(
  if ($UseCommandLauncher) { $commandLauncher }
  else { 'scripts/windows/Launcher.cs'; 'scripts/windows/launcher.manifest' }
)

$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$output = [IO.Directory]::CreateDirectory($outputPath).FullName
$archive = Join-Path $output $archiveName
if (Test-Path -LiteralPath $archive) { throw "Output already exists: $archive" }

$buildName = '.chatkeepsake-build-' + [guid]::NewGuid().ToString('N')
$build = Join-Path $output $buildName
New-Item -ItemType Directory -Path $build | Out-Null
try {
  if (!$NodeArchive) {
    $NodeArchive = Join-Path $build $nodeZipName
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeZipName" -OutFile $NodeArchive -TimeoutSec 180
  }
  if ((Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash -ne $nodeZipSha256) {
    throw "Node.js archive does not match the official SHA-256 for $nodeZipName."
  }

  $sourceArchive = Join-Path $build 'source.zip'
  git -C $repo archive --format=zip "--output=$sourceArchive" $commit -- @appFiles @launcherFiles
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive the application files from Git.' }

  $bundle = Join-Path $build 'ChatKeepsake'
  $app = Join-Path $bundle 'app'
  [IO.Compression.ZipFile]::ExtractToDirectory($sourceArchive, $app)

  npm.cmd ci --prefix $app --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the locked dependencies.' }

  if ($UseCommandLauncher) {
    $sourceLauncher = Join-Path $app $commandLauncher
    $launcher = [IO.File]::ReadAllText($sourceLauncher) -replace '\r?\n', "`r`n"
    [IO.File]::WriteAllText((Join-Path $bundle $commandLauncher), $launcher)
    Remove-Item -LiteralPath $sourceLauncher
  } else {
    foreach ($file in $launcherFiles) {
      Move-Item -LiteralPath (Join-Path $app $file) -Destination $build
    }
    Remove-Item -LiteralPath (Join-Path $app 'scripts/windows')
  }

  $nodeBundle = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $NodeArchive).ProviderPath)
  try {
    $nodeExe = $nodeBundle.GetEntry("$nodeFolder/node.exe")
    $nodeLicense = $nodeBundle.GetEntry("$nodeFolder/LICENSE")
    if (!$nodeExe -or !$nodeLicense) { throw 'The official Node.js archive is missing required files.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($nodeExe, (Join-Path $app 'node.exe'))
    [IO.Compression.ZipFileExtensions]::ExtractToFile($nodeLicense, (Join-Path $app 'Node.js-LICENSE.txt'))
  } finally {
    $nodeBundle.Dispose()
  }

  if (!$UseCommandLauncher) {
    $version = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric package version.' }
    [IO.File]::WriteAllText((Join-Path $build 'Version.cs'), ('[assembly: System.Reflection.AssemblyVersion("{0}.0")]' -f $version))
    $checksums = @(Get-ChildItem -LiteralPath $app -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
      $relative = [IO.Path]::GetRelativePath($app, $_.FullName).Replace('\', '/')
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
      "$hash $relative"
    })
    [IO.File]::WriteAllLines((Join-Path $build 'integrity.txt'), [string[]] $checksums)

    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $launcher = Join-Path $bundle 'ChatKeepsake.exe'
    $compilerArgs = @(
      '/nologo', '/optimize+', '/warnaserror+', '/target:exe', '/platform:x64', '/codepage:65001',
      "/out:$launcher", '/win32manifest:launcher.manifest', '/resource:integrity.txt,ChatKeepsake.files',
      'Launcher.cs', 'Version.cs'
    )
    Push-Location -LiteralPath $build
    try {
      & $compiler @compilerArgs
      if ($LASTEXITCODE -ne 0) { throw 'Could not compile ChatKeepsake.exe.' }
    } finally {
      Pop-Location
    }

    if ($SignLauncher) {
      & $SignLauncher $launcher | Out-Host
      $signature = Get-AuthenticodeSignature -LiteralPath $launcher
      $codeSigning = $signature.SignerCertificate.Extensions | Where-Object {
        $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] -and
          '1.3.6.1.5.5.7.3.3' -in $_.EnhancedKeyUsages.Value
      }
      if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or !$signature.TimeStamperCertificate -or
          $signature.SignerCertificate.Subject -eq $signature.SignerCertificate.Issuer -or !$codeSigning) {
        throw 'The release launcher must have a valid, timestamped Authenticode signature from a trusted CA.'
      }
    }
  }

  $temporaryZip = Join-Path $build $archiveName
  [IO.Compression.ZipFile]::CreateFromDirectory($bundle, $temporaryZip, [IO.Compression.CompressionLevel]::Optimal, $false)
  [IO.File]::Move($temporaryZip, $archive)
  Write-Output $archive
} finally {
  $directory = Get-Item -LiteralPath $build -Force -ErrorAction SilentlyContinue
  if ($directory -and $directory.Parent.FullName -eq [IO.Path]::TrimEndingDirectorySeparator($output) -and
      $directory.Name -eq $buildName -and !($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $directory.FullName -Recurse -Force
  }
}
