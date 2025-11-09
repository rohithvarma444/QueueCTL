# QueueCTL

A simple CLI job queue system with PostgreSQL, retry logic, and Dead Letter Queue.

**Additional Resources:**
- [Design Documentation](https://drive.google.com/file/d/1S7ielTmKQwyF937qMg-9GwQMUz4wvki3/view?usp=sharing)

## Setup Instructions

**Prerequisites:** Docker, Docker Compose

1. Start services:
   ```bash
   ./start.sh
   ```

2. You'll be in an interactive shell inside the container. Start using queuectl:
   ```bash
   queuectl status
   ```

3. Stop services (from host terminal):
   ```bash
   ./stop.sh
   ```

**Note:** The container automatically sets up the database and builds the application. The `queuectl` command is available immediately after starting.

## Usage Examples

**Enqueue a job:**
```bash
$ queuectl enqueue '{"command":"echo hello"}'
Job a1b2c3d4-e5f6-7890-abcd-ef1234567890 enqueued
```

**Schedule a job:**
```bash
$ queuectl enqueue '{"command":"echo hello","run_at":"2024-12-31T23:59:00Z"}'
Job b2c3d4e5-f6a7-8901-bcde-f1234567890 enqueued
```

**Job with timeout:**
```bash
$ queuectl enqueue '{"command":"sleep 10","timeout":5000}'
Job c3d4e5f6-a7b8-9012-cdef-1234567890ab enqueued
```

**Start workers:**
```bash
$ queuectl worker start --count 2
Started 2 worker(s)
  Worker 1 (PID: 123)
  Worker 2 (PID: 124)
```

**Check status:**
```bash
$ queuectl status

Queue Status

┌────────────┬───────┬───────┐
│ State      │ Count │ %     │
├────────────┼───────┼───────┤
│ PENDING    │ 2     │ 40.0% │
│ PROCESSING │ 0     │ 0.0%  │
│ COMPLETED  │ 3     │ 60.0% │
│ FAILED     │ 0     │ 0.0%  │
│ DEAD       │ 0     │ 0.0%  │
└────────────┴───────┴───────┘

Total: 5 jobs
Avg Duration: 0.15s
```

**View job output:**
```bash
$ queuectl show a1b2c3d4-e5f6-7890-abcd-ef1234567890

Job a1b2c3d4-e5f6-7890-abcd-ef1234567890

Command: echo hello
State: COMPLETED
Attempts: 0/3
Duration: 0.01s

Output:
hello
```

**Start dashboard:**
```bash
$ queuectl dashboard
Dashboard running at http://localhost:3000
```
Open http://localhost:3000 in browser

**DLQ operations:**
```bash
$ queuectl dlq list

Dead Letter Queue

┌──────────┬──────────────────┬──────────────────────────┐
│ ID       │ Command          │ Error                    │
├──────────┼──────────────────┼──────────────────────────┤
│ d4e5f6a7 │ exit 1           │ Exit code 1             │
└──────────┴──────────────────┴──────────────────────────┘

$ queuectl dlq retry d4e5f6a7
Job d4e5f6a7 back in queue
```

**Config operations:**
```bash
$ queuectl config set backoff_base 2
backoff_base = 2

$ queuectl config get backoff_base
backoff_base = 2

$ queuectl config get nonexistent_key
nonexistent_key = not set
```

## Architecture Overview

**Job Lifecycle:**
1. Job created with `PENDING` state
2. Worker locks and processes job → `PROCESSING`
3. On success → `COMPLETED` (output stored)
4. On failure → `FAILED` (scheduled retry with exponential backoff)
5. After max retries → `DEAD` (moved to DLQ)

**Data Persistence:**
- PostgreSQL stores all job data, state, and metrics
- Prisma ORM handles database operations
- Jobs include: command, state, attempts, priority, timeout, runAt, output, error

**Worker Logic:**
- Workers poll database for available jobs (respects `runAt` schedule)
- Optimistic locking prevents duplicate processing
- Jobs processed by priority (higher first)
- Timeout enforcement kills long-running jobs
- Metrics tracked for duration and completion

## Assumptions & Trade-offs

**Assumptions:**
- Single database instance (no distributed setup)
- Jobs are shell commands (not arbitrary code)
- Workers run on same machine/container
- No job dependencies or workflows

**Trade-offs:**
- Polling-based (not event-driven) - simpler but less efficient
- No job cancellation once processing starts
- Metrics stored in database (not external service)
- Simple timeout mechanism (SIGTERM, no graceful shutdown)

## Testing Instructions

**Run verification script (inside container):**
```bash
# After starting containers with ./start.sh
./verify.sh
```

This script verifies functionality:
- All CLI commands work
- Jobs persist and can be retrieved
- Job execution and output capture
- Retry mechanism with exponential backoff
- DLQ operations (move to DLQ, retry from DLQ)
- Multiple workers processing jobs
- Priority queue processing
- Scheduled jobs
- Job timeout enforcement

**Basic functionality test:**
```bash
# 1. Enqueue a job
queuectl enqueue '{"command":"echo test"}'

# 2. Start worker
queuectl worker start --count 1

# 3. Check status
queuectl status

# 4. View job details
queuectl show <job-id>
```

**Test retry mechanism:**
```bash
queuectl enqueue '{"command":"false","max_retries":3}'
queuectl worker start --count 1
sleep 10
queuectl status
```

**Test DLQ:**
```bash
queuectl enqueue '{"command":"exit 1","max_retries":1}'
queuectl worker start --count 1
sleep 5
queuectl dlq list
queuectl dlq retry <job-id>
```

**Test priority:**
```bash
queuectl enqueue '{"command":"echo Low","priority":1}'
queuectl enqueue '{"command":"echo High","priority":10}'
queuectl worker start --count 1
```

**Test scheduled jobs:**
```bash
queuectl enqueue '{"command":"echo Future","run_at":"2020-01-01T00:00:00Z"}'
queuectl status
```

**Test timeout:**
```bash
queuectl enqueue '{"command":"sleep 10","timeout":2000}'
queuectl worker start --count 1
sleep 3
queuectl list --state FAILED
```

**Test config:**
```bash
queuectl config set backoff_base 2
queuectl config get backoff_base
```

**Test dashboard:**
```bash
queuectl dashboard
# Open http://localhost:3000
```
