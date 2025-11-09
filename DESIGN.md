# QueueCTL Design

## Architecture

**Components:**
- **CLI** (`src/index.ts`) - Command-line interface using Commander.js
- **Database** (`src/db.ts`) - Prisma ORM with PostgreSQL for persistence
- **Workers** (`src/worker.ts`) - Job processing with retry and timeout handling
- **Dashboard** (`src/dashboard.ts`) - Web interface with Express and Chart.js

**Data Flow:**
1. User enqueues job via CLI → Stored in PostgreSQL
2. Worker polls database → Locks job → Executes command → Updates state
3. Dashboard queries database → Displays metrics and job status

## Key Design Decisions

**Database:** PostgreSQL chosen over SQLite/JSON for:
- Production readiness and ACID guarantees
- Concurrent access support
- Better performance with multiple workers

**Locking Strategy:** Optimistic locking using `updateMany` with `lockedBy: null` condition:
- Atomic operation prevents race conditions
- No deadlocks
- Simple implementation

**Retry Strategy:** Exponential backoff with configurable base:
- Formula: `delay = base^attempts` seconds
- Configurable via `queuectl config set backoff_base <value>`
- Prevents overwhelming system with retries

**Worker Model:** Polling-based (1s interval):
- Simple and reliable
- No message broker required
- Easy to debug and monitor

**Job Execution:** Shell commands via Node.js `spawn()`:
- Flexible - supports any command-line tool
- Captures stdout/stderr
- Handles exit codes for success/failure

## Job Lifecycle

```
PENDING → PROCESSING → COMPLETED
                ↓
             FAILED → (retry with backoff) → DEAD (DLQ)
```

## Concurrency

- Multiple workers can run simultaneously
- Optimistic locking ensures each job processed once
- Priority queue: higher priority jobs processed first
- Scheduled jobs: only processed after `runAt` time

