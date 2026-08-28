#!/bin/bash

# Exit immediately if any command fails
set -e

# 1. Fetch the latest changes from upstream
echo "Fetching from upstream..."
git fetch upstream

# 2. Ensure you are on the main branch
echo "Switching to main branch..."
git checkout main

# 3. Perform the merge without committing yet
echo "Merging upstream/main (holding commit)..."
git merge upstream/main --no-commit --no-ff || true

# 4. Force restore your local version of manifest.js from before the merge
echo "Preserving your local manifest.js..."
git checkout HEAD -- manifest.js

# 5. Commit the merge
echo "Committing the merge..."
git commit -m "Merge upstream/main while preserving manifest.js"

echo "-------------------------------------------"
echo "Sync complete! manifest.js was protected."
echo "-------------------------------------------"

# 6. Keep the window open
read -p "Press [Enter] to close this window..."
