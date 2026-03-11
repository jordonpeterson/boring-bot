#!/bin/sh
# Example review stage script — demonstrates the stage contract.
#
# Contract:
#   stdin:               Full git diff of the commits being pushed (UTF-8 text)
#   PIPELINE_COMMIT_SHA: 40-char SHA of the local commit being pushed
#   PIPELINE_BRANCH:     Local ref being pushed (e.g. refs/heads/feat/my-feature)
#   exit 0:              Stage passed — push proceeds
#   exit non-zero:       Stage failed — push is blocked; stdout/stderr shown to developer
#
# This script is a no-op placeholder. Replace it with your actual review logic,
# or add a new entry to pipeline.config.json pointing to your real review script.
#
# Examples of what a real review script might do:
#   - Pipe the diff to a Claude-based AI review agent
#   - Run eslint on changed files (using PIPELINE_COMMIT_SHA to find them)
#   - Check for forbidden patterns (console.log, TODO, etc.)
#   - Call an external code quality API

diff=$(cat)  # Read the full diff from stdin

if [ -z "$diff" ]; then
  echo "No diff to review — skipping."
  exit 0
fi

echo "Example review: received $(echo "$diff" | wc -l | tr -d ' ') lines of diff."
echo "PIPELINE_COMMIT_SHA=${PIPELINE_COMMIT_SHA}"
echo "PIPELINE_BRANCH=${PIPELINE_BRANCH}"
echo "Review passed (placeholder — replace with real logic)."
exit 0
