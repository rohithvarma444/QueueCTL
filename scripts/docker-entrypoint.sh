#!/bin/sh

set -e

echo "Starting QueueCTL application..."

echo "Waiting for PostgreSQL to be ready..."
sleep 3

echo "Setting up database schema..."

if [ -d "prisma/migrations" ] && [ "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "Applying migrations..."
  npx prisma migrate deploy --skip-generate || {
    echo "Migration deploy failed, trying db push..."
    npx prisma db push --accept-data-loss --skip-generate || true
  }
else
  echo "No migrations found, pushing schema..."
  npx prisma db push --accept-data-loss --skip-generate || true
fi

echo "Generating Prisma client..."
npx prisma generate

# Check if we should use nodemon for development
if [ "$NODE_ENV" = "development" ] || [ "$USE_NODEMON" = "true" ]; then
  echo ""
  echo "Installing/updating dependencies (including devDependencies)..."
  npm install
  
  echo ""
  echo "QueueCTL is ready!"
  echo "Starting with nodemon (watching for changes)..."
  echo "Changes to src/ will automatically reload the application"
  echo ""
  exec npm run dev:watch
else
  echo ""
  echo "QueueCTL is ready!"
  echo ""
  exec tail -f /dev/null
fi
