#!/bin/bash

set -e

echo "Starting QueueCTL Docker services..."

cd "$(dirname "$0")"

if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker and try again."
    exit 1
fi

echo "Stopping any existing containers..."
docker-compose -f docker/docker-compose.yml down 2>/dev/null || true

echo "Starting PostgreSQL and application containers..."
docker-compose -f docker/docker-compose.yml up -d --build

echo "Waiting for services to be ready..."
sleep 5

echo "QueueCTL is running!"
echo ""
echo "Opening interactive shell in container..."
echo "Run CLI commands like: queuectl status"
echo "Type 'exit' to return (containers will keep running)"
echo ""

docker-compose -f docker/docker-compose.yml exec app sh
