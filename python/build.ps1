# Builds Handwrite.exe and installs it to %LOCALAPPDATA%\Programs\Handwrite with Start menu and desktop shortcuts.
# Re-running it updates the app and keeps your settings and saved handwriting.
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$venv = "$env:USERPROFILE\.venvs\handwrite"
if (-not (Test-Path "$venv\Scripts\pyinstaller.exe")) {
    python -m venv $venv
    & "$venv\Scripts\python.exe" -m pip install -q numpy pyinstaller
}

Get-Process Handwrite -ErrorAction SilentlyContinue | Stop-Process  # a running copy locks its files
$b = "$env:TEMP\hwbuild"  # short path: deep folders trip Windows' 260-character path limit
& "$venv\Scripts\pyinstaller.exe" --noconfirm --windowed --name Handwrite --log-level WARN `
    --workpath "$b\work" --distpath "$b\dist" --specpath $b --paths $src `
    --add-data "$src\model.f16.bin;." --add-data "$src\styles;styles" `
    --add-data "$src\config.toml;." --add-data "$src\capture.html;." "$src\app.py"
if ($LASTEXITCODE) { throw "PyInstaller failed" }

$new = "$b\dist\Handwrite\_internal"
$dst = "$env:LOCALAPPDATA\Programs\Handwrite"
if (Test-Path "$dst\_internal\config.toml") { Copy-Item "$dst\_internal\config.toml" $new -Force }
if (Test-Path "$dst\_internal\styles") { Copy-Item "$dst\_internal\styles\*" "$new\styles" -Force }
robocopy "$b\dist\Handwrite" $dst /MIR /NJH /NJS /NP /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying to $dst failed" }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in [Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop")) {
    $lnk = $shell.CreateShortcut("$dir\Handwrite.lnk")
    $lnk.TargetPath = "$dst\Handwrite.exe"
    $lnk.WorkingDirectory = $dst
    $lnk.Save()
}
Write-Host "Installed to $dst (Start menu + desktop shortcut)."
