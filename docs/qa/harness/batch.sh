#!/bin/sh
cd /tmp/qa/bench
for cfg in "rc3v-small ud-rc3v ext-rc3v ws-rc3" "rc3v-big ud-rc3v ext-rc3v ws-rc3-big" "rc3w-small ud-rc3w ext-rc3w ws-rc3" "rc3w-big ud-rc3w ext-rc3w ws-rc3-big" "r4-small ud-r4 ext-r4 ws-rc3" "r4-big ud-r4 ext-r4 ws-rc3-big"; do
  set -- $cfg
  pkill -9 -f '[/]tmp/qa/vscode/code'; sleep 2
  echo "=== $1" >> out/batch.log
  ./run.sh vscode /tmp/qa/$2 /tmp/qa/$3 /tmp/qa/$4 5 $1 >> out/batch.log 2>&1
done
echo BATCHDONE >> out/batch.log
