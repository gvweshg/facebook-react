#!/usr/bin/env bash
set -eo pipefail

# Hashes JS files in the provided directory to create a cache-breaker

find $1 -name '*.js' | sort | xargs shasum | shasum | awk '{ print $1 }'
