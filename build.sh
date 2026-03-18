#!/bin/bash
set -e

echo "=== Reading docnet.config.json ==="

# Validate config exists
if [ ! -f "docnet.config.json" ]; then
  echo "❌ docnet.config.json not found. Copy docnet.config.example.json first."
  exit 1
fi

# Extract config values using node (avoids dependency on jq)
PROJECT_NAME=$(node -e "console.log(require('./docnet.config.json').project.name)")
WELCOME_TITLE=$(node -e "console.log(require('./docnet.config.json').ui.welcomeTitle)")
WELCOME_BODY=$(node -e "console.log(require('./docnet.config.json').ui.welcomeBody)")
HOW_TO_USE=$(node -e "console.log(JSON.stringify(require('./docnet.config.json').ui.howToUse))")
SEARCH_PLACEHOLDER=$(node -e "console.log(require('./docnet.config.json').ui.searchPlaceholder)")
REPO_URL=$(node -e "const v = require('./docnet.config.json').project.repoUrl; console.log(v || '')")
ACCENT_COLOR=$(node -e "console.log(require('./docnet.config.json').project.accentColor)")
AI_ATTRIBUTION_NOTE=$(node -e "console.log(require('./docnet.config.json').ui.aiAttributionNote)")
PRINCIPAL_NAME=$(node -e "const v = require('./docnet.config.json').principal.name; console.log(v || '')")
HOP_FILTER_ENABLED=$(node -e "console.log(require('./docnet.config.json').principal.hopFilterEnabled)")
YEAR_RANGE_MIN=$(node -e "console.log(require('./docnet.config.json').analysis.yearRangeMin)")
YEAR_RANGE_MAX=$(node -e "console.log(require('./docnet.config.json').analysis.yearRangeMax)")
DEFAULT_LIMIT=$(node -e "console.log(require('./docnet.config.json').ui.defaultRelationshipLimit)")
MOBILE_LIMIT=$(node -e "console.log(require('./docnet.config.json').ui.mobileRelationshipLimit)")
INCLUDE_UNDATED_DEFAULT=$(node -e "console.log(require('./docnet.config.json').analysis.includeUndatedDefault)")

echo "  Project: $PROJECT_NAME"
echo "  Principal: ${PRINCIPAL_NAME:-'(none)'}"

echo "=== Writing frontend environment ==="
cat > network-ui/.env.production << EOF
VITE_PROJECT_NAME=$PROJECT_NAME
VITE_WELCOME_TITLE=$WELCOME_TITLE
VITE_WELCOME_BODY=$WELCOME_BODY
VITE_HOW_TO_USE=$HOW_TO_USE
VITE_SEARCH_PLACEHOLDER=$SEARCH_PLACEHOLDER
VITE_REPO_URL=$REPO_URL
VITE_ACCENT_COLOR=$ACCENT_COLOR
VITE_AI_ATTRIBUTION_NOTE=$AI_ATTRIBUTION_NOTE
VITE_PRINCIPAL_NAME=$PRINCIPAL_NAME
VITE_HOP_FILTER_ENABLED=$HOP_FILTER_ENABLED
VITE_YEAR_RANGE_MIN=$YEAR_RANGE_MIN
VITE_YEAR_RANGE_MAX=$YEAR_RANGE_MAX
VITE_DEFAULT_LIMIT=$DEFAULT_LIMIT
VITE_MOBILE_LIMIT=$MOBILE_LIMIT
VITE_INCLUDE_UNDATED_DEFAULT=$INCLUDE_UNDATED_DEFAULT
EOF

echo "=== Installing root dependencies ==="
npm install

echo "=== Installing frontend dependencies ==="
cd network-ui
npm install

echo "=== Building frontend ==="
npm run build

echo "=== Verifying build ==="
if [ -d "dist" ]; then
  echo "✓ Frontend build successful"
else
  echo "✗ Frontend build failed"
  exit 1
fi

cd ..
echo "=== Build complete ==="
echo "Run: npx tsx api_server.ts"
