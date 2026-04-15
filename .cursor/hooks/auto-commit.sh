#!/bin/bash

set -e

# Go to repo root
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi
cd "$REPO_ROOT"

# Skip if no changes
if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

# Skip if merge conflicts exist
if git diff --name-only --diff-filter=U | grep -q .; then
  echo "Skipping auto-commit: merge conflicts detected"
  exit 0
fi

# Skip likely secret files
if git diff --name-only | grep -E '(^|/)\.env($|\.|/)|credentials|secret|token' >/dev/null; then
  echo "Skipping auto-commit: possible secret-related file changed"
  exit 0
fi

CHANGED_FILES="$(git diff --name-only | tr '\n' ' ' | sed 's/  */ /g' | sed 's/[[:space:]]*$//')"
COUNT="$(git diff --name-only | wc -l | tr -d ' ')"

git add -A
git commit -m "chore(auto): update ${COUNT} file(s) (${CHANGED_FILES:0:120})" || exit 0
git push origin main#!/usr/bin/env bash
set -euo pipefail

# Cursor hook payload arrives on stdin. We do not need fields for this behavior.
cat >/dev/null || true

# Run only inside a git repository.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# Avoid committing while conflicts exist.
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  exit 0
fi

# Nothing to commit.
if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

# Guardrail: do not auto-commit likely secrets.
if git status --porcelain | awk '{print $2}' | grep -E '(^|/)\.env($|\.|/)|credentials\.json$|secret|token' >/dev/null 2>&1; then
  exit 0
fi

# Stage all regular changes.
git add -A

# If staging produced nothing (rare), exit.
if git diff --cached --quiet; then
  exit 0
fi

file_count="$(git diff --cached --name-only | wc -l | tr -d ' ')"
summary_files="$(git diff --cached --name-only | head -n 3 | tr '\n' ', ' | sed 's/, $//')"

if [ -z "$summary_files" ]; then
  summary_files="repo updates"
fi

git commit -m "chore(auto): update ${file_count} file(s) (${summary_files})" >/dev/null 2>&1 || true

exit 0
