# Builds municipalities.js (name lookup table) and map.js (map shapes) for index.html.
#
# Sources:
#   - Statistics Finland, municipality boundaries 1:1 000 000 (WFS, CC BY 4.0)
#   - Statistics Finland classification service: municipality names per year, regions
#   - Finnish Wikipedia "Kuntaliitos Suomessa": table of municipal mergers since 1934
#
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File tools\build-data.ps1

param(
    [int]$Year = 2026,
    [int]$FirstHistoryYear = 1990
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$ua = 'breaker-map/1.0 (municipality map builder)'
$classApi = 'https://data.stat.fi/api/classifications/v2'
$inv = [Globalization.CultureInfo]::InvariantCulture

function Get-Json([string]$url) {
    # Download as bytes and decode as UTF-8 ourselves; PowerShell 5.1 guesses the charset wrong otherwise.
    $wc = New-Object Net.WebClient
    $wc.Headers.Add('User-Agent', $ua)
    $bytes = $wc.DownloadData($url)
    return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}

function Get-ClassItems([string]$id, [string]$lang) {
    $items = Get-Json "$classApi/classifications/$id/classificationItems?content=data&meta=max&lang=$lang&format=json"
    $result = @{}
    foreach ($it in $items) {
        $name = ($it.classificationItemNames | Where-Object { $_.lang -eq $lang } | Select-Object -First 1).name
        if (-not $name) { $name = $it.classificationItemNames[0].name }
        $result[$it.code] = $name
    }
    return $result
}

# ---------------------------------------------------------------- current municipalities
Write-Host "Downloading $Year municipality boundaries..."
$wfs = "https://geo.stat.fi/geoserver/tilastointialueet/wfs?service=WFS&version=2.0.0&request=GetFeature" +
       "&typeName=tilastointialueet:kunta1000k_$Year&outputFormat=application/json&srsName=EPSG:3067"
$geo = Get-Json $wfs
Write-Host "  $($geo.features.Count) municipalities"

Write-Host "Downloading regions..."
$regionNamesFi = Get-ClassItems "maakunta_1_${Year}0101" 'fi'
$regionNamesSv = Get-ClassItems "maakunta_1_${Year}0101" 'sv'
$regionOf = @{}
$maps = Get-Json "$classApi/correspondenceTables/kunta_1_${Year}0101%23maakunta_1_${Year}0101/maps?format=json&lang=fi"
foreach ($m in $maps) {
    # Each entry is a URL ending in /maps/<municipality code>/<region code>
    $parts = $m -split '/'
    $regionOf[$parts[-2]] = $parts[-1]
}

# ---------------------------------------------------------------- historical names per code
Write-Host "Downloading historical municipality names $FirstHistoryYear-$($Year - 1)..."
$histFi = @{}   # code -> list of Finnish names used over the years
$histSv = @{}
$lastYearOf = @{}
for ($y = $FirstHistoryYear; $y -lt $Year; $y++) {
    try {
        $fi = Get-ClassItems "kunta_1_${y}0101" 'fi'
        $sv = Get-ClassItems "kunta_1_${y}0101" 'sv'
    } catch {
        Write-Host "  $y not available, skipping"
        continue
    }
    foreach ($code in $fi.Keys) {
        if ($code -notmatch '^\d{3}$') { continue }   # placeholder rows like "SSS" / "***"
        if (-not $histFi[$code]) { $histFi[$code] = New-Object Collections.Generic.List[string] }
        if (-not $histFi[$code].Contains($fi[$code])) { $histFi[$code].Add($fi[$code]) }
        $lastYearOf[$code] = $y
    }
    foreach ($code in $sv.Keys) {
        if ($code -notmatch '^\d{3}$') { continue }
        if (-not $histSv[$code]) { $histSv[$code] = New-Object Collections.Generic.List[string] }
        if (-not $histSv[$code].Contains($sv[$code])) { $histSv[$code].Add($sv[$code]) }
    }
}

# ---------------------------------------------------------------- merger table
Write-Host "Downloading merger table from Wikipedia..."
$wp = Get-Json 'https://fi.wikipedia.org/w/api.php?action=parse&page=Kuntaliitos_Suomessa&prop=wikitext&format=json&formatversion=2&redirects=1'
$wt = $wp.parse.wikitext
$start = $wt.IndexOf('{| class="wikitable sortable"')
$end = $wt.IndexOf("`n|}", $start)
$table = $wt.Substring($start, $end - $start)
$table = [regex]::Replace($table, '<ref[^>]*/>', '')
$table = [regex]::Replace($table, '(?s)<ref[^>]*>.*?</ref>', '')

$mergedInto = @{}   # old code -> code it was merged into
$mergedName = @{}   # old code -> name as written in the table
$mergedYear = @{}
$spanTarget = $null
$spanLeft = 0
foreach ($row in ($table -split "`n\|-")) {
    $cells = @($row -split "`n" | Where-Object { $_ -match '^\|(?![-}])' } | ForEach-Object { $_.Substring(1) })
    if ($cells.Count -lt 2 -or $cells[0] -notmatch '^\s*(\d{4})') { continue }
    $yr = [int]$Matches[1]
    $m = [regex]::Match($cells[1], '\[\[(?:[^\]|]*\|)?([^\]]+)\]\][^(]*\((\d{3})\)')
    if (-not $m.Success) { continue }
    $oldName = $m.Groups[1].Value
    $oldCode = $m.Groups[2].Value

    $target = $null
    if ($spanLeft -gt 0) {
        $target = $spanTarget
        $spanLeft--
    } elseif ($cells.Count -ge 3) {
        # "(088<arrow>111)" means the target municipality got a new code in the same merger
        $t = [regex]::Match($cells[2], '\((\d{3})(?:\s*' + [char]0x2192 + '\s*(\d{3}))?\)')
        if ($t.Success) {
            $target = $t.Groups[1].Value
            if ($t.Groups[2].Success) {
                $mergedInto[$target] = $t.Groups[2].Value
                $target = $t.Groups[2].Value
            }
        }
        $rs = [regex]::Match($cells[2], 'rowspan\s*=\s*"?(\d+)')
        if ($rs.Success) { $spanTarget = $target; $spanLeft = [int]$rs.Groups[1].Value - 1 }
    }
    if ($target -and $target -ne $oldCode) {
        $mergedInto[$oldCode] = $target
        $mergedName[$oldCode] = $oldName
        $mergedYear[$oldCode] = $yr
    }
}
Write-Host "  $($mergedInto.Count) mergers parsed"

# ---------------------------------------------------------------- build lookup records
$current = @{}
foreach ($f in $geo.features) { $current[$f.properties.kunta] = $f.properties }

function Resolve-Code([string]$code) {
    $seen = @{}
    while (-not $current.ContainsKey($code)) {
        if ($seen[$code] -or -not $mergedInto.ContainsKey($code)) { return $null }
        $seen[$code] = $true
        $code = $mergedInto[$code]
    }
    return $code
}

$records = @{}
foreach ($code in $current.Keys) {
    $p = $current[$code]
    $records[$code] = [ordered]@{
        code = $code; fi = $p.nimi; sv = $p.namn
        region = $regionOf[$code]
        old = New-Object Collections.Generic.List[object]
    }
    # Earlier names of the same municipality (renames keep the code)
    $names = @()
    if ($histFi[$code]) { $names += $histFi[$code] }
    if ($histSv[$code]) { $names += $histSv[$code] }
    foreach ($n in ($names | Select-Object -Unique)) {
        if ($n -ne $p.nimi -and $n -ne $p.namn) { $records[$code].old.Add([ordered]@{ name = $n; code = $code }) }
    }
}

$unresolved = @()
$oldCodes = @($histFi.Keys) + @($mergedInto.Keys) | Select-Object -Unique
foreach ($oc in $oldCodes) {
    if ($current.ContainsKey($oc)) { continue }
    $target = Resolve-Code $oc
    if (-not $target) { $unresolved += $oc; continue }
    $names = @()
    if ($histFi[$oc]) { $names += $histFi[$oc] }
    if ($histSv[$oc]) { $names += $histSv[$oc] }
    if ($mergedName[$oc]) { $names += $mergedName[$oc] }
    foreach ($n in ($names | Select-Object -Unique)) {
        $records[$target].old.Add([ordered]@{ name = $n; code = $oc })
    }
}
if ($unresolved.Count) { Write-Host "  No current municipality found for old codes: $($unresolved -join ', ')" }

# ---------------------------------------------------------------- geometry
$minX = [double]::MaxValue; $maxX = [double]::MinValue; $minY = [double]::MaxValue; $maxY = [double]::MinValue
function Get-Polygons($geom) {
    if ($geom.type -eq 'Polygon') { return , @(, $geom.coordinates) }
    return , $geom.coordinates
}
foreach ($f in $geo.features) {
    foreach ($poly in (Get-Polygons $f.geometry)) { foreach ($ring in $poly) { foreach ($pt in $ring) {
        if ($pt[0] -lt $minX) { $minX = $pt[0] }; if ($pt[0] -gt $maxX) { $maxX = $pt[0] }
        if ($pt[1] -lt $minY) { $minY = $pt[1] }; if ($pt[1] -gt $maxY) { $maxY = $pt[1] }
    } } }
}
$pad = 5000
$minX -= $pad; $maxY += $pad
$width = [math]::Ceiling(($maxX + $pad - $minX) / 1000)
$height = [math]::Ceiling(($maxY - ($minY - $pad)) / 1000)

function Fmt([double]$v) { return ([math]::Round($v, 1)).ToString($inv) }

function Get-RingArea($ring) {
    $a = 0.0
    for ($i = 0; $i -lt $ring.Count - 1; $i++) { $a += $ring[$i][0] * $ring[$i + 1][1] - $ring[$i + 1][0] * $ring[$i][1] }
    return $a / 2
}

function Test-InRing($ring, [double]$x, [double]$y) {
    $inside = $false
    $j = $ring.Count - 1
    for ($i = 0; $i -lt $ring.Count; $i++) {
        $xi = $ring[$i][0]; $yi = $ring[$i][1]; $xj = $ring[$j][0]; $yj = $ring[$j][1]
        if ((($yi -gt $y) -ne ($yj -gt $y)) -and ($x -lt ($xj - $xi) * ($y - $yi) / ($yj - $yi) + $xi)) { $inside = -not $inside }
        $j = $i
    }
    return $inside
}

function Get-LabelPoint($poly) {
    # Centroid of the outer ring; if it falls outside (crescent shapes), use the middle of the
    # widest horizontal span through the polygon at the centroid's height.
    $ring = $poly[0]
    $a = 0.0; $cx = 0.0; $cy = 0.0
    for ($i = 0; $i -lt $ring.Count - 1; $i++) {
        $c = $ring[$i][0] * $ring[$i + 1][1] - $ring[$i + 1][0] * $ring[$i][1]
        $a += $c; $cx += ($ring[$i][0] + $ring[$i + 1][0]) * $c; $cy += ($ring[$i][1] + $ring[$i + 1][1]) * $c
    }
    $cx /= (3 * $a); $cy /= (3 * $a)
    $inHole = $false
    for ($h = 1; $h -lt $poly.Count; $h++) { if (Test-InRing $poly[$h] $cx $cy) { $inHole = $true } }
    if ((Test-InRing $ring $cx $cy) -and -not $inHole) { return @($cx, $cy) }

    $xs = New-Object Collections.Generic.List[double]
    foreach ($r in $poly) {
        for ($i = 0; $i -lt $r.Count - 1; $i++) {
            $y1 = $r[$i][1]; $y2 = $r[$i + 1][1]
            if (($y1 -gt $cy) -ne ($y2 -gt $cy)) { $xs.Add($r[$i][0] + ($cy - $y1) * ($r[$i + 1][0] - $r[$i][0]) / ($y2 - $y1)) }
        }
    }
    $xs.Sort()
    $best = 0; $bx = $cx
    for ($i = 0; $i + 1 -lt $xs.Count; $i += 2) {
        if ($xs[$i + 1] - $xs[$i] -gt $best) { $best = $xs[$i + 1] - $xs[$i]; $bx = ($xs[$i] + $xs[$i + 1]) / 2 }
    }
    return @($bx, $cy)
}

Write-Host 'Converting shapes...'
$shapes = New-Object Text.StringBuilder
foreach ($f in ($geo.features | Sort-Object { $_.properties.kunta })) {
    $code = $f.properties.kunta
    $d = New-Object Text.StringBuilder
    $biggest = $null; $biggestArea = 0
    foreach ($poly in (Get-Polygons $f.geometry)) {
        $area = [math]::Abs((Get-RingArea $poly[0]))
        if ($area -gt $biggestArea) { $biggestArea = $area; $biggest = $poly }
        foreach ($ring in $poly) {
            $prev = ''
            $first = $true
            foreach ($pt in $ring) {
                $s = (Fmt (($pt[0] - $minX) / 1000)) + ' ' + (Fmt (($maxY - $pt[1]) / 1000))
                if ($s -eq $prev) { continue }
                [void]$d.Append($(if ($first) { 'M' } else { 'L' })).Append($s)
                $prev = $s; $first = $false
            }
            [void]$d.Append('Z')
        }
    }
    $lp = Get-LabelPoint $biggest
    $lx = Fmt (($lp[0] - $minX) / 1000); $ly = Fmt (($maxY - $lp[1]) / 1000)
    [void]$shapes.Append("  `"$code`": { d: `"$($d.ToString())`", label: [$lx, $ly] },`n")
}

# ---------------------------------------------------------------- write files
function Js([string]$s) { return '"' + $s.Replace('\', '\\').Replace('"', '\"') + '"' }
$utf8 = New-Object Text.UTF8Encoding($false)
$stamp = (Get-Date).ToString('yyyy-MM-dd')

$mapJs = "// Generated by tools/build-data.ps1 on $stamp. Do not edit by hand.`n" +
         "// Municipality boundaries $Year (c) Statistics Finland, CC BY 4.0. Units: km, ETRS-TM35FIN.`n" +
         "window.MAP_DATA = {`n  width: $width,`n  height: $height,`n  shapes: {`n" + $shapes.ToString() + "  }`n};`n"
[IO.File]::WriteAllText((Join-Path $root 'map.js'), $mapJs, $utf8)

$sb = New-Object Text.StringBuilder
[void]$sb.Append("// Generated by tools/build-data.ps1 on $stamp. Do not edit by hand.`n")
[void]$sb.Append("// Sources: Statistics Finland (municipalities $Year, regions, names $FirstHistoryYear-$($Year - 1)), fi.wikipedia.org 'Kuntaliitos Suomessa'.`n")
[void]$sb.Append("// old: earlier municipalities merged into this one, and earlier names of this one, with their municipality codes.`n")
[void]$sb.Append("window.MUNICIPALITY_YEAR = $Year;`n")
[void]$sb.Append("window.REGIONS = {`n")
foreach ($rc in ($regionNamesFi.Keys | Sort-Object)) {
    [void]$sb.Append("  `"$rc`": { fi: $(Js $regionNamesFi[$rc]), sv: $(Js $regionNamesSv[$rc]) },`n")
}
[void]$sb.Append("};`nwindow.MUNICIPALITIES = [`n")
foreach ($code in ($records.Keys | Sort-Object)) {
    $r = $records[$code]
    $old = ($r.old | ForEach-Object { "{ name: $(Js $_.name), code: `"$($_.code)`" }" }) -join ', '
    [void]$sb.Append("  { code: `"$code`", fi: $(Js $r.fi), sv: $(Js $r.sv), region: `"$($r.region)`", old: [$old] },`n")
}
[void]$sb.Append("];`n")
[IO.File]::WriteAllText((Join-Path $root 'municipalities.js'), $sb.ToString(), $utf8)

$oldCount = ($records.Values | ForEach-Object { $_.old.Count } | Measure-Object -Sum).Sum
Write-Host "Wrote municipalities.js ($($records.Count) municipalities, $oldCount old names) and map.js (${width}x${height} km)"
