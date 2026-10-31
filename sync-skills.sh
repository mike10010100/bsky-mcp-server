#!/usr/bin/env bash
set -e

# Sync script for bsky-mcp-server skills to local Antigravity directories

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"

# Targets: global config and local gemini skills
TARGET_DIRS=(
  "$HOME/.gemini/config/skills"
  "$HOME/.gemini/skills"
)

echo "=== Syncing bsky-mcp-server skills ==="

for target in "${TARGET_DIRS[@]}"; do
  if [ -d "$(dirname "$target")" ]; then
    mkdir -p "$target"
    for skill_path in "$SKILLS_DIR"/*; do
      if [ -d "$skill_path" ]; then
        skill_name="$(basename "$skill_path")"
        echo "Linking $skill_name -> $target/$skill_name"
        rm -rf "$target/$skill_name"
        ln -sf "$skill_path" "$target/$skill_name"
      fi
    done
  fi
done

# Also sync bsky-troll-handler if present in root
if [ -d "$SCRIPT_DIR/bsky-troll-handler" ]; then
  for target in "${TARGET_DIRS[@]}"; do
    if [ -d "$target" ]; then
      echo "Linking bsky-troll-handler -> $target/bsky-troll-handler"
      rm -rf "$target/bsky-troll-handler"
      ln -sf "$SCRIPT_DIR/bsky-troll-handler" "$target/bsky-troll-handler"
    fi
  done
fi

echo "Done! Skills are symlinked to local Antigravity configuration."
