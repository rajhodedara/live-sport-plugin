
#!/bin/bash

# ============================================================
# Live Sports Plugin - GitHub Fork Synchronization
#
# origin   = TheGalch/live-sport-plugin
# upstream = rajhodedara/live-sport-plugin
# ============================================================

# ------------------------------------------------------------
# Repository location
# ------------------------------------------------------------
REPO="E:\LiveSportsPlugin\live-sport-plugin"

# ------------------------------------------------------------
# Stop on errors
# ------------------------------------------------------------
set -e

# ------------------------------------------------------------
# Function to pause before closing
# ------------------------------------------------------------
pause() {
    echo ""
    read -p "Press [Enter] to close this window..."
}

# ------------------------------------------------------------
# Start
# ------------------------------------------------------------
echo ""
echo "============================================================"
echo "       LIVE SPORTS PLUGIN - GIT SYNCHRONIZATION"
echo "============================================================"
echo ""

# ------------------------------------------------------------
# Go to repository
# ------------------------------------------------------------
echo "[1/9] Opening repository..."
echo ""

if [ ! -d "$REPO" ]; then
    echo "ERROR: Repository directory not found:"
    echo "$REPO"
    pause
    exit 1
fi

cd "$REPO"

echo "Repository:"
pwd

echo ""

# ------------------------------------------------------------
# Verify Git
# ------------------------------------------------------------
echo "[2/9] Checking Git..."

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "ERROR: This directory is not a Git repository."
    pause
    exit 1
fi

echo "Git repository detected."

# ------------------------------------------------------------
# Verify branch
# ------------------------------------------------------------
echo ""
echo "[3/9] Switching to main..."

git checkout main

echo "Current branch:"
git branch --show-current

# ------------------------------------------------------------
# Verify remotes
# ------------------------------------------------------------
echo ""
echo "[4/9] Checking GitHub remotes..."

ORIGIN=$(git remote get-url origin)
UPSTREAM=$(git remote get-url upstream)

echo ""
echo "origin:"
echo "  $ORIGIN"

echo ""
echo "upstream:"
echo "  $UPSTREAM"

echo ""

if [[ "$ORIGIN" != "https://github.com/TheGalch/live-sport-plugin.git" ]]; then
    echo "ERROR: origin is not your expected fork!"
    pause
    exit 1
fi

if [[ "$UPSTREAM" != "https://github.com/rajhodedara/live-sport-plugin.git" ]]; then
    echo "ERROR: upstream is not the expected repository!"
    pause
    exit 1
fi

echo "Remotes verified."

# ------------------------------------------------------------
# Check local changes
# ------------------------------------------------------------
echo ""
echo "[5/9] Checking for local changes..."

if [[ -n "$(git status --porcelain)" ]]; then

    echo ""
    echo "The following local changes were found:"
    echo "------------------------------------------------------------"

    git status --short

    echo "------------------------------------------------------------"
    echo ""

    echo "Staging local changes..."
    git add -A

    echo ""
    echo "Creating local commit..."

    git commit -m "Save local changes"

    echo ""
    echo "Pushing local changes to your fork..."

    git push origin main

    echo ""
    echo "Local changes successfully pushed."

else

    echo "No local changes found."

fi

# ------------------------------------------------------------
# Save manifest.js
# ------------------------------------------------------------
echo ""
echo "[6/9] Protecting manifest.js..."

MANIFEST="src/manifest.js"
TEMP_MANIFEST=$(mktemp)

if [ ! -f "$MANIFEST" ]; then
    echo "WARNING: $MANIFEST does not exist."
    echo "Continuing without protecting it."
    PROTECT_MANIFEST=false
else
    cp "$MANIFEST" "$TEMP_MANIFEST"
    PROTECT_MANIFEST=true
    echo "manifest.js backed up."
fi

# ------------------------------------------------------------
# Fetch upstream
# ------------------------------------------------------------
echo ""
echo "[7/9] Fetching upstream/main..."

git fetch upstream

echo ""
echo "Upstream fetched successfully."

# ------------------------------------------------------------
# Merge upstream
# ------------------------------------------------------------
echo ""
echo "[8/9] Merging upstream/main..."

git merge upstream/main --no-commit --no-ff

# ------------------------------------------------------------
# Restore manifest.js
# ------------------------------------------------------------
if [ "$PROTECT_MANIFEST" = true ]; then

    echo ""
    echo "Restoring your local manifest.js..."

    cp "$TEMP_MANIFEST" "$MANIFEST"

    rm "$TEMP_MANIFEST"

    git add "$MANIFEST"

    echo "Local manifest.js restored."

fi

# ------------------------------------------------------------
# Commit merge
# ------------------------------------------------------------
echo ""
echo "Creating merge commit..."

if git diff --cached --quiet; then

    echo "No merge commit required."

else

    git commit -m "Merge upstream/main while preserving manifest.js"

fi

# ------------------------------------------------------------
# Push
# ------------------------------------------------------------
echo ""
echo "Pushing synchronized main to your fork..."

git push origin main

# ------------------------------------------------------------
# Final status
# ------------------------------------------------------------
echo ""
echo "============================================================"
echo "                    SYNCHRONIZATION COMPLETE"
echo "============================================================"
echo ""
echo "Your fork:"
echo "  https://github.com/TheGalch/live-sport-plugin"
echo ""
echo "Upstream:"
echo "  https://github.com/rajhodedara/live-sport-plugin"
echo ""
echo "Your local changes:  COMMITTED + PUSHED"
echo "Upstream changes:    MERGED"
echo "manifest.js:         PRESERVED"
echo "origin/main:         UPDATED"
echo ""
echo "============================================================"

pause
```
