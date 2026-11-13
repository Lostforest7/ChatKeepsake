#Requires -Version 7.0
[CmdletBinding()]
param(
  [string] $OutputDirectory = (Join-Path $PSScriptRoot '../dist'),
  [string] $NodeArchive
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
$commit = git -C $repo rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git commit.' }

$nodeVersion = '24.22.3'
$nodeFolder = "node-v$nodeVersion-win-x64"
$nodeZipName = "$nodeFolder.zip"
# SHA-256 from the official Node.js release announcement.
$nodeZipSha256 = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
$launcherName = '启动 ChatKeepsake.cmd'
$archiveName = 'ChatKeepsake-Windows-x64.zip'

# Package only committed application files. Local exports and installed helpers stay out of the ZIP.
$appFiles = @(
  $launcherName, 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json',
  'archive.js', 'chat-content.js', 'discover-wechat.js', 'download-assets.js',
  'launcher.js', 'make-viewer.js', 'media.js', 'repair-videos.js', 'repair-voices.js',
  'run-process.js', 'save-attachments.js', 'server.js', 'transcribe.py',
  'voice-assets.json', 'voice-runtime.js', 'weflow.js',
  'public', 'viewer', 'demo', 'scripts/wechat-open-databases.ps1'
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
  git -C $repo archive --format=zip "--output=$sourceArchive" $commit -- @appFiles
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive the application files from Git.' }

  $bundle = Join-Path $build 'ChatKeepsake'
  $app = Join-Path $bundle 'app'
  [IO.Compression.ZipFile]::ExtractToDirectory($sourceArchive, $app)

  $sourceLauncher = Join-Path $app $launcherName
  $launcher = [IO.File]::ReadAllText($sourceLauncher) -replace '\r?\n', "`r`n"
  [IO.File]::WriteAllText((Join-Path $bundle $launcherName), $launcher)
  Remove-Item -LiteralPath $sourceLauncher

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
