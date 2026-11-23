#!/bin/sh
cd /tmp/qa/hl
for ws in small big; do for kind in kql esql; do for sem in on off; do
  echo "=== $ws $kind $sem" >> out/batch.log
  ./run.sh /tmp/qa/ws-hl-$ws $kind 5 dark $sem $ws-$kind-dark-$sem >> out/batch.log 2>&1
done; done; done
for kind in kql esql; do for theme in dark light; do for sem in on off; do
  echo "=== shots $kind $theme $sem" >> out/batch.log
  ./run.sh /tmp/qa/ws-hl-small $kind 1 $theme $sem shots-$kind-$theme-$sem --shots >> out/batch.log 2>&1
done; done; done
echo BATCHDONE >> out/batch.log
