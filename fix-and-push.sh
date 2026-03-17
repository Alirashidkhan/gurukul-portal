#!/bin/bash
# EduCore Website Fix & Push Script
# Run this from inside the educore-website folder on your Mac

set -e

echo "🔍 Step 1: Finding the educore-website folder..."
# Check we're in the right place
if [ ! -f "index.html" ]; then
  echo "❌ ERROR: index.html not found. Make sure you're in the educore-website folder"
  exit 1
fi

echo "🗑️  Step 2: Clearing stale remote reference..."
git update-ref -d refs/remotes/origin/main 2>/dev/null || true

echo "📥 Step 3: Fetching actual state from GitHub..."
git fetch origin

echo "🔍 Step 4: Checking what GitHub actually has..."
REMOTE_FIXES=$(git show origin/main:index.html 2>/dev/null | grep -c 'onclick="openEnquiry()"' || echo "0")
echo "   GitHub currently has: $REMOTE_FIXES button fixes"

echo "🔍 Step 5: Checking your local file..."
LOCAL_FIXES=$(grep -c 'onclick="openEnquiry()"' index.html || echo "0")
echo "   Your local file has: $LOCAL_FIXES button fixes"

if [ "$LOCAL_FIXES" -eq "6" ]; then
  echo "✅ Local file already has all fixes!"
  echo "📤 Step 6: Resetting remote reference and force pushing..."
  git fetch origin
  git branch --set-upstream-to=origin/main main 2>/dev/null || true
  git push origin main --force-with-lease
else
  echo "⚠️  Local file missing fixes. Applying them now..."
  
  # Apply all 6 fixes
  # Fix 1: Navbar Book Demo button
  sed -i '' 's|<a href="#contact" class="btn btn-ghost">Book Demo</a>|<button onclick="openEnquiry()" class="btn btn-ghost" style="border:none;background:none;cursor:pointer;">Book Demo<\/button>|g' index.html
  
  # Fix 2: Hero Book Free Demo button  
  sed -i '' 's|<a href="#contact" class="btn btn-gold btn-hero"><i class="fa fa-calendar-check"><\/i> Book Free Demo<\/a>|<button onclick="openEnquiry()" class="btn btn-gold btn-hero" style="border:none;background:var(--gold);cursor:pointer;"><i class="fa fa-calendar-check"><\/i> Book Free Demo<\/button>|g' index.html
  
  # Fix 3: Starter plan Get Started
  sed -i '' 's|<a href="#contact" class="btn btn-price btn-price-outline">Get Started<\/a>|<button onclick="openEnquiry()" class="btn btn-price btn-price-outline" style="cursor:pointer;">Get Started<\/button>|g' index.html
  
  # Fix 4: Professional plan Get Started
  sed -i '' 's|<a href="#contact" class="btn btn-price btn-price-gold">Get Started <i class="fa fa-arrow-right"><\/i><\/a>|<button onclick="openEnquiry()" class="btn btn-price btn-price-gold" style="cursor:pointer;">Get Started <i class="fa fa-arrow-right"><\/i><\/button>|g' index.html
  
  # Fix 5: Enterprise Talk to Sales
  sed -i '' 's|<a href="#contact" class="btn btn-price btn-price-outline">Talk to Sales<\/a>|<button onclick="openEnquiry()" class="btn btn-price btn-price-outline" style="cursor:pointer;">Talk to Sales<\/button>|g' index.html
  
  # Fix 6: ROI calculator button
  sed -i '' 's|<a href="#contact" class="btn btn-gold" style="width:100%;justify-content:center;margin-top:4px;">Get a Custom ROI Report|<button onclick="openEnquiry()" class="btn btn-gold" style="width:100%;justify-content:center;margin-top:4px;border:none;cursor:pointer;">Get a Custom ROI Report|g' index.html
  sed -i '' 's|Get a Custom ROI Report <i class="fa fa-arrow-right"><\/i><\/a>|Get a Custom ROI Report <i class="fa fa-arrow-right"><\/i><\/button>|g' index.html
  
  FIXED_COUNT=$(grep -c 'onclick="openEnquiry()"' index.html || echo "0")
  echo "   Applied $FIXED_COUNT fixes"
  
  git add index.html
  git commit -m "Fix: Connect all CTA buttons to openEnquiry() popup"
  git push origin main
fi

echo ""
echo "✅ DONE! Changes pushed to GitHub."
echo "⏳ Wait 1-2 minutes, then visit:"
echo "   https://alirashidkhan.github.io/educore-website/"
echo ""
echo "🧪 Test: Click 'Book Demo' button — popup should open!"
