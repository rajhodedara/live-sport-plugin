```bash
#!/bin/bash

sync_repository() {

    # Stop if a command fails
    set -e

    echo ""
    echo "==========================================="
    echo "     Live Sports Plugin Synchronization"
    echo "==========================================="

    # -----------------------------------------
    # Configuration
    # -----------------------------------------
    BRANCH="main"
    MANIFEST="src/manifest.js"

    ORIGIN_REPO="https://github.com/TheGalch/live-sport-plugin.git"
    UPSTREAM_REPO="https://github.com/rajhodedara/live-sport-plugin.git"

    # -----------------------------------------
    # 1. Verify remotes
    # -----------------------------------------
    echo ""
    echo "[1/8] Verifying Git remotes..."

    CURRENT_ORIGIN=$(git remote get-url origin)
    CURRENT_UPSTREAM=$(git remote get-url upstream)

    if [[ "$CURRENT_ORIGIN" != "$ORIGIN_REPO" ]]; then
        echo ""
        echo "ERROR: origin does not match your fork!"
        echo "Expected:"
        echo "$ORIGIN_REPO"
        echo "Found:"
        echo "$CURRENT_ORIGIN"
        return 1
    fi

    if [[ "$CURRENT_UPSTREAM" != "$UPSTREAM_REPO" ]]; then
        echo ""
        echo "ERROR: upstream does not match the original repository!"
        echo "Expected:"
        echo "$UPSTREAM_REPO"
        echo "Found:"
        echo "$CURRENT_UPSTREAM"
        return 1
    fi

    echo "origin   -> $CURRENT_ORIGIN"
    echo "upstream -> $CURRENT_UPSTREAM"

    # -----------------------------------------
    # 2. Switch to main
    # -----------------------------------------
    echo ""
    echo "[2/8] Switching to main..."

    git checkout "$BRANCH"

    # -----------------------------------------
    # 3. Save local changes
    # -----------------------------------------
    echo ""
    echo "[3/8] Checking for local changes..."

    if [[ -n "$(git status --porcelain)" ]]; then

        echo ""
        echo "Local changes detected:"
        git status --short

        echo ""
        echo "Staging local changes..."
        git add -A

        echo ""
        echo "Committing local changes..."
        git commit -m "Save local changes"

        echo ""
        echo "Pushing local changes to origin/main..."
        git push origin "$BRANCH"

        echo ""
        echo "Local changes successfully committed and pushed."

    else

        echo "No local changes detected."

    fi

    # -----------------------------------------
    # 4. Save local manifest.js
    # -----------------------------------------
    echo ""
    echo "[4/8] Saving local manifest.js..."

    TEMP_MANIFEST=$(mktemp)

    cp "$MANIFEST" "$TEMP_MANIFEST"

    echo "Local manifest.js saved."

    # -----------------------------------------
    # 5. Fetch upstream
    # -----------------------------------------
    echo ""
    echo "[5/8] Fetching upstream/main..."

    git fetch upstream

    # -----------------------------------------
    # 6. Merge upstream
    # -----------------------------------------
    echo ""
    echo "[6/8] Merging upstream/main..."

    git merge upstream/main --no-commit --no-ff

    # -----------------------------------------
    # 7. Restore local manifest.js
    # -----------------------------------------
    echo ""
    echo "[7/8] Restoring your local manifest.js..."

    cp "$TEMP_MANIFEST" "$MANIFEST"

    rm "$TEMP_MANIFEST"

    git add "$MANIFEST"

    echo "Local manifest.js restored."

    # -----------------------------------------
    # 8. Commit and push
    # -----------------------------------------
    echo ""
    echo "[8/8] Committing and pushing merge..."

    if git diff --cached --quiet; then

        echo "No merge changes detected."

    else

        git commit -m "Merge upstream/main while preserving manifest.js"

    fi

    echo ""
    echo "Pushing to origin/main..."

    git push origin "$BRANCH"

    # -----------------------------------------
    # Done
    # -----------------------------------------
    echo ""
    echo "==========================================="
    echo "                 SUCCESS!"
    echo "==========================================="
    echo ""
    echo "Your fork has been synchronized."
    echo ""
    echo "  Your local changes  -> committed"
    echo "  Your local changes  -> pushed"
    echo "  upstream/main       -> merged"
    echo "  manifest.js         -> preserved"
    echo "  origin/main         -> updated"
    echo ""
    echo "==========================================="
}

# -----------------------------------------
# Execute
# -----------------------------------------

if sync_repository; then

    echo ""
    echo "Synchronization completed successfully."

else

    echo ""
    echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    echo "ERROR: Synchronization failed!"
    echo ""
    echo "The script stopped to prevent an"
    echo "incomplete or incorrect synchronization."
    echo ""
    echo "Run:"
    echo ""
    echo "    git status"
    echo ""
    echo "to see the current repository state."
    echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

fi

echo ""
read -p "Press [Enter] to close this window..."
```
