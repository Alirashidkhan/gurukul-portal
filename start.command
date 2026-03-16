#!/bin/bash

# Navigate to this script's folder (works even if double-clicked)
cd "$(dirname "$0")"

echo ""
echo "🛑 Stopping any running server on port 3001..."
kill $(lsof -t -i:3001) 2>/dev/null
pkill -f "node server/server.js" 2>/dev/null
sleep 1

echo "✅ Starting Gurukul Portal Server on port 3001..."
echo ""
node server/server.js
