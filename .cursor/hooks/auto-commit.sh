#!/usr/bin/env bash
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
