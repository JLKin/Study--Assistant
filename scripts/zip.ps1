param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Compress-Archive -LiteralPath $Source -DestinationPath $Destination -CompressionLevel Optimal
