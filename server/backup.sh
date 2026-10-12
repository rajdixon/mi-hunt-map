#!/bin/sh
# Nightly snapshot of ~/mi-hunt-data (pins, logs, tracks, photos) into
# ~/mi-hunt-backups/YYYY-MM-DD. Unchanged files are hard links to the day
# before, so 30 days of photos take about the space of one copy.
# ~/mi-hunt-backups/latest points at the newest one (the Mac copies that).
#
# Restore: systemctl --user stop mi-hunt
#          rsync -a --delete ~/mi-hunt-backups/<day>/ ~/mi-hunt-data/
#          systemctl --user start mi-hunt
set -eu
SRC="$HOME/mi-hunt-data/"
DST="$HOME/mi-hunt-backups"
KEEP=30
mkdir -p "$DST" && chmod 700 "$DST"
today=$(date -u +%F)
prev=$(ls -1d "$DST"/20??-??-?? 2>/dev/null | grep -v "/$today\$" | tail -1 || true)
rsync -a --delete ${prev:+--link-dest="$prev"} "$SRC" "$DST/$today/"
# Every data file must still be readable before it becomes "latest"
for f in "$DST/$today"/*.json; do
  [ -e "$f" ] || continue
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f"
done
ln -sfn "$today" "$DST/latest"
ls -1d "$DST"/20??-??-?? | head -n -"$KEEP" | xargs -r rm -rf
echo "Snapshot $DST/$today: $(find "$DST/$today" -type f | wc -l) files, $(du -sh "$DST/$today" | cut -f1)"
