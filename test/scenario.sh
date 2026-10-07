#!/usr/bin/env bash
# Scenario test for the bridge against /opt/vault-test (throwaway vault + bare remote).
set -u
T=/opt/vault-test; V=$T/vault; R=$T/remote.git; SEED=$T/seed
LOG=/tmp/bridge-test.log
cd /opt/git-syncthing-bridge
export VAULT_PATH=$V SYNCTHING_FOLDER_ID=bridge-test DEBOUNCE_MS=3000 PULL_INTERVAL_MS=30000 \
       DASHBOARD_PASSWORD= LOG_LEVEL=info MAX_FILE_MB=1 NOTIFY_URL=
pass=0; fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
start() { COMMIT_MODE=$1 /usr/bin/node src/index.js >>$LOG 2>&1 & PID=$!; sleep 6; }
stopb() { kill $PID; wait $PID 2>/dev/null; }
remote_has() { git -C $R show main:"$1" >/dev/null 2>&1; }
: > $LOG

echo "== immediate mode"
start immediate
echo "hello" > $V/Live.md; sleep 12
check "live edit committed and pushed" "remote_has Live.md"

for i in 1 2 3; do echo "burst $i" >> $V/Burst.md; sleep 1; done; sleep 12
check "burst of edits pushed, final content" "git -C $R show main:Burst.md | grep -q 'burst 3'"

(cd $SEED && git pull -q && echo "from desktop" > Desktop.md && git add -A && git commit -qm desktop && git push -q)
curl -s -o /dev/null -X POST -H 'X-Bridge: 1' http://127.0.0.1:1/ 2>/dev/null  # no-op
sleep 40   # periodic fetch (30s) + rebase
check "remote change rebased into vault" "[ -f $V/Desktop.md ]"
check "folder not left paused" "[ ! -f $V/.git/bridge-paused-syncthing ]"
check "history is linear (no merge commits)" "[ -z \"\$(git -C $V log --merges --oneline)\" ]"

echo "x" > "$V/Live.sync-conflict-20261007-120000-ABCDEFG.md"; echo "more" >> $V/Live.md; sleep 12
check "conflict copy not committed" "! git -C $R ls-tree -r --name-only main | grep -q sync-conflict"
check "other edits still committed (warn policy)" "git -C $R show main:Live.md | grep -q more"
check "conflict alert logged" "grep -q 'ALERT Sync conflicts' $LOG"
rm "$V/Live.sync-conflict-20261007-120000-ABCDEFG.md"

head -c 2000000 /dev/urandom > $V/big-video.mp4; head -c 300000 /dev/urandom > $V/photo2.jpg; sleep 12
check "photo committed" "remote_has photo2.jpg"
check "file over MAX_FILE_MB excluded" "! remote_has big-video.mp4 && grep -q big-video.mp4 $V/.git/info/exclude"

# Real divergence: same line edited on both sides
(cd $SEED && git pull -q && echo "desktop version" > Clash.md && git add -A && git commit -qm clash && git push -q)
echo "phone version" > $V/Clash.md; sleep 45
check "divergence alerted, not silently merged" "grep -q 'ALERT Vault diverged' $LOG && ! grep -q 'desktop version' $V/Clash.md"
check "local edit kept in a local commit" "git -C $V show HEAD:Clash.md | grep -q 'phone version'"
stopb
# resolve divergence the way a human would: take local on top of remote
git -C $V fetch -q && git -C $V -c user.name=t -c user.email=t rebase -X theirs -q origin/main >/dev/null 2>&1 || git -C $V rebase --abort

echo "== crash recovery"
touch -d '1 hour ago' $V/.git/index.lock 2>/dev/null || touch $V/.git/index.lock
start immediate
check "stale index.lock removed at startup" "[ ! -f $V/.git/index.lock ]"
stopb

echo "== daily mode"
start daily
echo "d1" > $V/Daily.md; sleep 12
first=$(git -C $V rev-parse HEAD)
echo "d2" >> $V/Daily.md; sleep 12
check "second edit amended into today's commit" "[ \"\$(git -C $V log -1 --format=%s)\" = \"vault: \$(date +%F)\" ] && [ \$(git -C $V log --format=%s | grep -c \"vault: \$(date +%F)\") -ge 1 ] && git -C $V show HEAD --stat | grep -q Daily.md"
check "today's commit held back (not pushed)" "! remote_has Daily.md"
stopb

echo; echo "RESULT: $pass passed, $fail failed"
echo "---- bridge log (warnings/errors) ----"; grep -E 'WARN|ERROR|ALERT' $LOG | cut -c1-200
