#!/bin/bash

set -e

echo "Stopping QueueCTL Docker services..."

cd "$(dirname "$0")"

docker-compose -f docker/docker-compose.yml down

echo "All QueueCTL services stopped!"
