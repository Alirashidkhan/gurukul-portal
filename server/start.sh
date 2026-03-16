#!/bin/bash
# start.sh — Start Gurukul Portal server and seed data
# Usage: ./start.sh  OR  bash start.sh

cd "$(dirname "$0")"

echo "🔄 Stopping any existing server..."
pkill -f "node server.js" 2>/dev/null || true
sleep 2

echo "🚀 Starting server..."
node server.js > /tmp/gurukul-server.log 2>&1 &
SERVER_PID=$!
echo "   Server PID: $SERVER_PID"

echo "⏳ Waiting for server to be ready..."
sleep 5

echo "🌱 Seeding data..."
node seed-data.js

echo ""
echo "✅ Server is running!"
echo "   Portal:  http://localhost:3001/portal/login.html"
echo "   Website: http://localhost:3001/index.html"
echo "   Logs:    tail -f /tmp/gurukul-server.log"
