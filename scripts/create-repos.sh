#!/bin/bash
# =============================================================================
# Forge — Create Repos on GitHub (icohangar-ops, Cubiczan) and Codeberg (cubiczan)
# =============================================================================
# Prerequisites:
#   1. Install gh CLI: https://cli.github.com/
#   2. Authenticate: gh auth login
#   3. For Codeberg: set CODEBERG_TOKEN env var (Settings → Access Tokens)
#
# Usage: bash scripts/create-repos.sh
# =============================================================================

set -euo pipefail

REPO_NAME="forge"
REPO_DESC="Self-improving agent system for production deployment — multi-agent pipeline with feedback flywheel"
FORGE_DIR="/home/z/forge"

echo "🔧 Creating Forge repositories..."

# ---------------------------------------------------------------------------
# GitHub 1: icohangar-ops
# ---------------------------------------------------------------------------
echo ""
echo "── GitHub: icohangar-ops/${REPO_NAME} ──"
if gh repo view icohangar-ops/${REPO_NAME} &>/dev/null; then
    echo "   ✅ Already exists"
else
    gh repo create icohangar-ops/${REPO_NAME} \
        --public \
        --description "${REPO_DESC}" \
        --source "${FORGE_DIR}" \
        --push
    echo "   ✅ Created and pushed"
fi

# ---------------------------------------------------------------------------
# GitHub 2: Cubiczan
# ---------------------------------------------------------------------------
echo ""
echo "── GitHub: Cubiczan/${REPO_NAME} ──"
if gh repo view Cubiczan/${REPO_NAME} &>/dev/null; then
    echo "   ✅ Already exists"
else
    gh repo create Cubiczan/${REPO_NAME} \
        --public \
        --description "${REPO_DESC}" \
        --source "${FORGE_DIR}" \
        --push
    echo "   ✅ Created and pushed"
fi

# ---------------------------------------------------------------------------
# Codeberg: cubiczan
# ---------------------------------------------------------------------------
echo ""
echo "── Codeberg: cubiczan/${REPO_NAME} ──"

if [ -z "${CODEBERG_TOKEN:-}" ]; then
    echo "   ⚠️  CODEBERG_TOKEN not set. Skipping Codeberg."
    echo "   To create on Codeberg, run:"
    echo ""
    echo "   export CODEBERG_TOKEN=<your-token>"
    echo "   curl -X POST https://codeberg.org/api/v1/user/repos \\"
    echo "     -H 'Authorization: token \$CODEBERG_TOKEN' \\"
    echo "     -H 'Content-Type: application/json' \\"
    echo "     -d '{\"name\":\"${REPO_NAME}\",\"description\":\"${REPO_DESC}\",\"private\":false,\"auto_init\":false}'"
    echo ""
    echo "   Then push:"
    echo "   git -C ${FORGE_DIR} remote add codeberg https://codeberg.org/cubiczan/${REPO_NAME}.git"
    echo "   git -C ${FORGE_DIR} push codeberg main"
else
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "https://codeberg.org/api/v1/user/repos" \
        -H "Authorization: token ${CODEBERG_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"${REPO_NAME}\",\"description\":\"${REPO_DESC}\",\"private\":false,\"auto_init\":false}")

    if [ "$HTTP_CODE" = "201" ]; then
        echo "   ✅ Created on Codeberg"
        git -C "${FORGE_DIR}" remote add codeberg "https://codeberg.org/cubiczan/${REPO_NAME}.git" 2>/dev/null || true
        git -C "${FORGE_DIR}" push codeberg main
        echo "   ✅ Pushed to Codeberg"
    elif [ "$HTTP_CODE" = "409" ]; then
        echo "   ✅ Already exists on Codeberg"
        git -C "${FORGE_DIR}" remote add codeberg "https://codeberg.org/cubiczan/${REPO_NAME}.git" 2>/dev/null || true
        git -C "${FORGE_DIR}" push codeberg main
        echo "   ✅ Pushed to Codeberg"
    else
        echo "   ❌ Error (HTTP ${HTTP_CODE}). Check your token."
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Forge repositories created!"
echo ""
echo "  GitHub 1:  https://github.com/icohangar-ops/${REPO_NAME}"
echo "  GitHub 2:  https://github.com/Cubiczan/${REPO_NAME}"
echo "  Codeberg:  https://codeberg.org/cubiczan/${REPO_NAME}"
echo "═══════════════════════════════════════════════════"