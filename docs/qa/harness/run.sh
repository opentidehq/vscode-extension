#!/bin/sh
# usage: run.sh <editor> <ud> <ext> <ws> <runs> <label>   (starts Xvfb + openbox, runs bench.js)
exec xvfb-run -a -s "-screen 0 1600x1000x24" sh -c 'openbox >/dev/null 2>&1 & sleep 1; node /tmp/qa/bench/bench.js "$@"' sh "$@"
