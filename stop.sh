#!/bin/bash

set -e

echo "Stopping QueueCTL Docker services..."

cd "$(dirname "$0")"

docker-compose -f docker/docker-compose.yml down

# Remove old postgres volume if it exists (database will be fresh on next start)
# Try common volume name patterns
docker volume rm docker_postgres_data 2>/dev/null || true
docker volume rm queuectl_postgres_data 2>/dev/null || true

echo "All QueueCTL services stopped!"
