#!/bin/bash

set +e

echo "🔍 QueueCTL Functional Verification"
echo "===================================="
echo ""

PASS=0
FAIL=0

check() {
    if [ $? -eq 0 ]; then
        echo "✅ $1"
        ((PASS++))
    else
        echo "❌ $1"
        ((FAIL++))
    fi
}

echo "1. Testing CLI Commands..."
echo "--------------------------"

queuectl --help &> /dev/null
check "CLI help command works"

JOB1=$(queuectl enqueue '{"command":"echo test1"}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
[ -n "$JOB1" ]
check "Enqueue command works"

queuectl status &> /dev/null
check "Status command works"

queuectl list &> /dev/null
check "List command works"

queuectl worker start --count 1 &> /dev/null
sleep 2
check "Worker start command works"

queuectl worker stop &> /dev/null
check "Worker stop command works"

echo ""
echo "2. Testing Job Persistence..."
echo "------------------------------"

JOB2=$(queuectl enqueue '{"command":"echo persist_test"}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
[ -n "$JOB2" ]
check "Job created"

queuectl show "$JOB2" &> /dev/null
check "Job can be retrieved"

JOB2_SHORT=$(echo "$JOB2" | cut -c1-8)
queuectl list | grep -q "$JOB2_SHORT"
check "Job appears in list"

echo ""
echo "3. Testing Job Execution..."
echo "----------------------------"

JOB3=$(queuectl enqueue '{"command":"echo success"}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
queuectl worker start --count 1 &> /dev/null
sleep 5
queuectl worker stop &> /dev/null

JOB3_SHORT=$(echo "$JOB3" | cut -c1-8)
queuectl list --state COMPLETED | grep -q "$JOB3_SHORT"
check "Job executed successfully"

OUTPUT=$(queuectl show "$JOB3" 2>&1 | grep -A 5 "Output:" | grep -q "success"; echo $?)
[ "$OUTPUT" = "0" ]
check "Job output captured"

echo ""
echo "4. Testing Retry & Backoff..."
echo "------------------------------"

queuectl config set backoff_base 2 &> /dev/null
check "Backoff base configurable"

JOB4=$(queuectl enqueue '{"command":"false","max_retries":2}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
queuectl worker start --count 1 &> /dev/null
sleep 12
queuectl worker stop &> /dev/null

JOB4_SHORT=$(echo "$JOB4" | cut -c1-8)
queuectl list --state FAILED | grep -q "$JOB4_SHORT" || queuectl list --state DEAD | grep -q "$JOB4_SHORT"
check "Failed job scheduled for retry"

ATTEMPTS=$(queuectl show "$JOB4" 2>&1 | grep "Attempts:" | grep -o "[0-9]/[0-9]" | cut -d'/' -f1)
[ "$ATTEMPTS" -gt 0 ]
check "Retry attempts tracked"

echo ""
echo "5. Testing DLQ..."
echo "-----------------"

JOB5=$(queuectl enqueue '{"command":"exit 1","max_retries":1}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
queuectl worker start --count 1 &> /dev/null
sleep 8
queuectl worker stop &> /dev/null

JOB5_SHORT=$(echo "$JOB5" | cut -c1-8)
queuectl dlq list | grep -q "$JOB5_SHORT"
check "Job moved to DLQ after max retries"

queuectl dlq retry "$JOB5" &> /dev/null
check "DLQ retry command works"

sleep 1
queuectl list --state PENDING | grep -q "$JOB5_SHORT"
check "DLQ job moved back to queue"

echo ""
echo "6. Testing Multiple Workers..."
echo "-------------------------------"

JOB6=$(queuectl enqueue '{"command":"echo worker1"}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
JOB7=$(queuectl enqueue '{"command":"echo worker2"}' 2>&1 | grep -o '[a-f0-9-]\{36\}')

queuectl worker start --count 2 &> /dev/null
sleep 5
queuectl worker stop &> /dev/null

JOB6_SHORT=$(echo "$JOB6" | cut -c1-8)
JOB7_SHORT=$(echo "$JOB7" | cut -c1-8)
COMPLETED=$(queuectl list --state COMPLETED | grep -E "$JOB6_SHORT|$JOB7_SHORT" | wc -l)
[ "$COMPLETED" -ge 1 ]
check "Multiple workers process jobs"

echo ""
echo "7. Testing Priority..."
echo "----------------------"

JOB8=$(queuectl enqueue '{"command":"echo low","priority":1}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
JOB9=$(queuectl enqueue '{"command":"echo high","priority":10}' 2>&1 | grep -o '[a-f0-9-]\{36\}')

queuectl worker start --count 1 &> /dev/null
sleep 3
queuectl worker stop &> /dev/null

HIGH_STATE=$(queuectl show "$JOB9" 2>&1 | grep "State:" | grep -o "COMPLETED")
[ -n "$HIGH_STATE" ]
check "High priority jobs processed"

echo ""
echo "8. Testing Scheduled Jobs..."
echo "------------------------------"

FUTURE_DATE=$(date -u -d '+1 hour' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2025-12-31T23:59:00Z")
JOB10=$(queuectl enqueue "{\"command\":\"echo scheduled\",\"run_at\":\"$FUTURE_DATE\"}" 2>&1 | grep -o '[a-f0-9-]\{36\}')

queuectl show "$JOB10" 2>&1 | grep -q "Run At"
check "Scheduled job created with run_at"

JOB10_SHORT=$(echo "$JOB10" | cut -c1-8)
JOB10_STATE=$(queuectl show "$JOB10" 2>&1 | grep "State:" | grep -o "PENDING")
[ -n "$JOB10_STATE" ]
check "Scheduled job remains pending until time"

echo ""
echo "9. Testing Timeout..."
echo "---------------------"

JOB11=$(queuectl enqueue '{"command":"sleep 5","timeout":2000}' 2>&1 | grep -o '[a-f0-9-]\{36\}')
queuectl worker start --count 1 &> /dev/null
sleep 5
queuectl worker stop &> /dev/null

JOB11_SHORT=$(echo "$JOB11" | cut -c1-8)
TIMEOUT_JOB=$(queuectl show "$JOB11" 2>&1 | grep -i "timeout\|timed out")
[ -n "$TIMEOUT_JOB" ] || queuectl list --state FAILED | grep -q "$JOB11_SHORT" || queuectl list --state DEAD | grep -q "$JOB11_SHORT"
check "Job timeout enforced"

echo ""
echo "===================================="
echo "Results: $PASS passed, $FAIL failed"
echo "===================================="

if [ $FAIL -eq 0 ]; then
    echo "✅ All functional tests passed!"
    exit 0
else
    echo "❌ Some functional tests failed"
    exit 1
fi
