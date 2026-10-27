# install.ps1 - Fast installer for opencode-cline-free on Windows
$ErrorActionPreference = "Stop"

$PluginPkg = "github:itsyasirkhandev/opencode-cline-free"
$RawBundleUrl = "https://raw.githubusercontent.com/itsyasirkhandev/opencode-cline-free/main/dist/cline-free.js"

Write-Host "==> Installing opencode-cline-free..." -ForegroundColor Cyan

# 1. Determine config directory
$ConfigDir = if ($env:XDG_CONFIG_HOME) {
    Join-Path $env:XDG_CONFIG_HOME "opencode"
} else {
    Join-Path $env:USERPROFILE ".config\opencode"
}
$PluginsDir = Join-Path $ConfigDir "plugins"
$ConfigFile = Join-Path $ConfigDir "opencode.json"

if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

# 2. Check for opencode CLI in PATH or Windows Desktop AppData
$CliBin = $null
if (Get-Command "opencode" -ErrorAction SilentlyContinue) {
    $CliBin = "opencode"
} elseif (Get-Command "opencode-cli" -ErrorAction SilentlyContinue) {
    $CliBin = "opencode-cli"
} else {
    $Candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\@opencodedesktop\resources\opencode-cli.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\opencode\opencode.exe"),
        (Join-Path $env:ProgramFiles "OpenCode\opencode.exe")
    )
    foreach ($cand in $Candidates) {
        if (Test-Path $cand) {
            $CliBin = $cand
            break
        }
    }
}

if ($CliBin) {
    Write-Host "--> Found OpenCode CLI at: $CliBin" -ForegroundColor Gray
    try {
        & $CliBin plugin add $PluginPkg
        Write-Host "✓ Successfully installed via OpenCode CLI!" -ForegroundColor Green
    } catch {
        Write-Host "Warning: CLI command failed ($($_.Exception.Message)). Falling back to direct configuration..." -ForegroundColor Yellow
        $CliBin = $null
    }
}

if (-not $CliBin) {
    Write-Host "--> Configuring OpenCode Desktop directly (no CLI or PATH needed)..." -ForegroundColor Gray
    $Updated = $false

    if (Test-Path $ConfigFile) {
        try {
            $raw = Get-Content -Raw -Path $ConfigFile -Encoding UTF8
            $config = $raw | ConvertFrom-Json
            if (-not $config.plugins) {
                $config | Add-Member -MemberType NoteProperty -Name "plugins" -Value @()
            }
            if ($config.plugins -notcontains $PluginPkg) {
                $config.plugins = @($config.plugins) + $PluginPkg
                $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigFile -Encoding UTF8
                Write-Host "✓ Added $PluginPkg to $ConfigFile" -ForegroundColor Green
            } else {
                Write-Host "✓ $PluginPkg is already configured in $ConfigFile" -ForegroundColor Yellow
            }
            $Updated = $true
        } catch {
            Write-Host "Note: Could not parse $ConfigFile as standard JSON (may contain comments). Falling back to standalone bundle..." -ForegroundColor Yellow
        }
    } else {
        $newConfig = [ordered]@{
            "`$schema" = "https://opencode.ai/config.json"
            plugins = @($PluginPkg)
        }
        $newConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigFile -Encoding UTF8
        Write-Host "✓ Created $ConfigFile with $PluginPkg" -ForegroundColor Green
        $Updated = $true
    }

    if (-not $Updated) {
        if (-not (Test-Path $PluginsDir)) {
            New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
        }
        $Target = Join-Path $PluginsDir "cline-free.js"
        Write-Host "--> Downloading standalone plugin bundle to $Target..." -ForegroundColor Gray
        Invoke-WebRequest -Uri $RawBundleUrl -OutFile $Target -UseBasicParsing
        Write-Host "✓ Installed standalone bundle to $Target" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "✓ opencode-cline-free installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Launch OpenCode (or restart OpenCode Desktop)." -ForegroundColor White
Write-Host "2. Run /connect in chat (or go to Settings > Providers in Desktop)." -ForegroundColor White
Write-Host "3. Select 'Cline Free' to connect your account." -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green
