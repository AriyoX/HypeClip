param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

function Update-LaunchPath {
    $paths = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
    $env:Path = ($paths -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Find-Node {
    $nodePaths = @(Get-Command node.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    $nodePaths += Join-Path $env:ProgramFiles 'nodejs\node.exe'
    foreach ($nodePath in $nodePaths | Select-Object -Unique) {
        if (Test-Path -LiteralPath $nodePath -PathType Leaf) {
            $version = & $nodePath -p 'process.versions.node'
            if ($LASTEXITCODE -eq 0 -and $version -match '^\d+\.\d+\.\d+$' -and [version]$version -ge [version]'22.15.0') {
                return $nodePath
            }
        }
    }
}

try {
    Update-LaunchPath
    $node = Find-Node
    if (!$node) {
        $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (!(Test-Path -LiteralPath $winget)) {
            $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
        }
        if (!$winget) { throw 'Install or update App Installer from Microsoft Store, then open Start HypeClip again.' }
        $answer = Read-Host 'Install Node.js LTS through WinGet? [Y/n]'
        if ($answer -and $answer -notmatch '^(y|yes)$') { exit 0 }
        & $winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -ne 0) { throw 'WinGet could not install Node.js. Check its message above and try again.' }
        Update-LaunchPath
        $node = Find-Node
        if (!$node) { throw 'Node.js is unavailable. Close this window and open Start HypeClip again.' }
    }

    $nodeFolder = Split-Path -Parent $node
    $env:Path = "$nodeFolder;$env:Path"
    $stamp = 'node_modules/.hypeclip-install'
    $fingerprint = (Get-FileHash -LiteralPath 'pnpm-lock.yaml').Hash + (Get-FileHash -LiteralPath 'package.json').Hash
    if (!(Test-Path -LiteralPath $stamp) -or (Get-Content -LiteralPath $stamp -Raw).Trim() -ne $fingerprint -or !(Test-Path -LiteralPath 'node_modules/commander/package.json')) {
        $npm = Join-Path $nodeFolder 'npm.cmd'
        if (!(Test-Path -LiteralPath $npm)) { throw 'Install Node.js LTS with npm, then open Start HypeClip again.' }
        $pnpm = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).packageManager
        Write-Host 'Installing HypeClip packages...'
        & $npm exec --yes --prefer-offline --package $pnpm -- pnpm install --frozen-lockfile --prefer-offline
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the HypeClip packages. Check your connection and try again.' }
        Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ascii
    }

    Write-Host 'Starting HypeClip. Keep this window open while using the studio.'
    $studioArgs = @('--experimental-strip-types', 'cli.ts', 'dashboard')
    if (!$NoBrowser) { $studioArgs += '--open' }
    & $node @studioArgs
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
