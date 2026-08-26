param(
  [string]$OutputDirectory = "$PSScriptRoot\build"
)

$ErrorActionPreference = "Stop"
dotnet publish "$PSScriptRoot\SemaFrameVoiceRelayHelper.csproj" `
  --configuration Release `
  --runtime win-x64 `
  --self-contained true `
  --output $OutputDirectory `
  -p:PublishSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false
