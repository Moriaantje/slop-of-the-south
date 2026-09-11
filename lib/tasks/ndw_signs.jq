# NDW current-state GeoJSON → one TSV row per sign inside the bbox ($lon0 $lat0 $lon1 $lat1), streamed (see ndw.rake)
fromstream(2 | truncate_stream(inputs | select(.[0][0] == "features")))
| select(.geometry.type == "Point")
| (.geometry.coordinates) as [$lon, $lat]
| select($lon >= $lon0 and $lon <= $lon1 and $lat >= $lat0 and $lat <= $lat1)
| .properties as $p
| [ .id, $p.rvvCode, ($p.blackCode // ""), ($p.zoneCode // ""), (($p.textSigns // []) | map(.text // "") | map(select(. != "")) | join(" | ")),
    ($p.bearing // ""), ($p.side // ""), ($p.placement // ""), ($p.drivingDirection // ""), ($p.roadName // ""), ($p.townName // ""),
    ($p.countyCode // ""), ($p.imageUrl // ""), ($p.status // ""), (if $p.validated == "j" then "t" else "f" end), ($p.firstSeenOn // ""), $lon, $lat ]
| map(tostring | gsub("\\s"; " ") | gsub("\\\\"; "/")) | @tsv
