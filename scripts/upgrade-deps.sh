#!/usr/bin/env bash

# Fail on error
set -e

# Echo commands
set -x

# Exclude known problem packages
EXCLUDE=""

npx npm-check-updates --workspaces --root --upgrade --reject "$EXCLUDE"

npx sort-package-json package.json
