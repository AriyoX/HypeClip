param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $shows = Get-Content -Raw -LiteralPath (Join-Path $Directory speech.json) | ConvertFrom-Json
    foreach ($show in $shows) {
        $voice.SelectVoice("Microsoft $($show[3]) Desktop")
        for ($i=0; $i -lt $show[5].Count; $i++) {
            $voice.SetOutputToWaveFile((Join-Path $Directory "$($show[0])-$i.wav"))
            $voice.Speak($show[5][$i][1])
            $voice.SetOutputToNull()
        }
    }
} finally { $voice.Dispose() }
