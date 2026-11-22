$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    $revision = git rev-parse --short HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not identify the committed source.' }
    $releaseDir = Join-Path $PWD '.hypeclip/releases'
    $toolsDir = Join-Path $PWD '.hypeclip/installer-tools'
    New-Item -ItemType Directory -Path $releaseDir, $toolsDir -Force | Out-Null

    $nsisZip = Join-Path $toolsDir 'nsis-3.13.zip'
    $nsisHash = 'BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8'
    if (!(Test-Path -LiteralPath $nsisZip) -or (Get-FileHash -LiteralPath $nsisZip).Hash -ne $nsisHash) {
        & curl.exe --fail --silent --show-error --location --output $nsisZip 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip'
        if ($LASTEXITCODE -ne 0) { throw 'Could not download NSIS.' }
    }
    if ((Get-FileHash -LiteralPath $nsisZip).Hash -ne $nsisHash) { throw 'NSIS archive checksum mismatch.' }
    $compiler = Join-Path $toolsDir 'nsis-3.13/makensis.exe'
    if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {
        Expand-Archive -LiteralPath $nsisZip -DestinationPath $toolsDir -Force
    }

    $zip = Join-Path $releaseDir "HypeClip-Windows-$revision.zip"
    $installer = Join-Path $releaseDir "HypeClip-Setup-$revision.exe"
    git archive --format=zip --prefix=HypeClip/ --output=$zip HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Windows ZIP.' }

    $build = Join-Path $releaseDir ".build-$([guid]::NewGuid())"
    Expand-Archive -LiteralPath $zip -DestinationPath $build
    try {
        $app = Join-Path $build 'HypeClip'
        $version = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
        $cleanup = Join-Path $build 'uninstall-files.nsh'
        $entries = Get-ChildItem -LiteralPath $app -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending
        $commands = foreach ($entry in $entries) {
            $relative = $entry.FullName.Substring($app.Length + 1).Replace('$', '$$')
            $operation = if ($entry.PSIsContainer) { 'RMDir' } else { 'Delete' }
            '{0} "$INSTDIR\app\{1}"' -f $operation, $relative
        }
        Set-Content -LiteralPath $cleanup -Value $commands -Encoding utf8
        & $compiler '/V2' "/DAPP_VERSION=$version" "/DAPP_FILES=$app" "/DAPP_CLEANUP=$cleanup" "/DINSTALLER_FILE=$installer" 'scripts/windows-installer.nsi'
        if ($LASTEXITCODE -ne 0) { throw 'Could not build the Windows installer.' }
        Get-Item -LiteralPath $installer, $zip | Select-Object FullName, Length
    } finally {
        $resolvedBuild = (Resolve-Path -LiteralPath $build).ProviderPath
        if ($resolvedBuild -ieq $build -and $resolvedBuild.StartsWith($releaseDir + '\.build-', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedBuild -Recurse
        }
    }
} finally {
    Pop-Location
}
