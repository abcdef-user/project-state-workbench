$ErrorActionPreference = 'Stop'
$launcherCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $launcherCompiler)) { throw '需要 Windows .NET Framework C# 编译器。也可直接使用根目录的启动工作台.cmd。' }
& $launcherCompiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ("/out:" + (Join-Path $PSScriptRoot 'ProjectWorkbench.exe')) (Join-Path $PSScriptRoot 'app\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败。' }
Write-Output (Join-Path $PSScriptRoot 'ProjectWorkbench.exe')
