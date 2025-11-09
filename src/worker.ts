import { spawn } from 'child_process';
import { db } from './db';
import { JobState } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const PID_FILE = path.join(process.cwd(), '.worker-pids');

export async function startWorkers(count: number) {
  const pids: number[] = [];
  
  for (let i = 0; i < count; i++) {
    const worker = spawn('node', [path.join(__dirname, 'worker.js')], {
      detached: true,
      stdio: 'ignore',
    });
    
    if (worker.pid) {
      pids.push(worker.pid);
    }
    
    worker.unref();
  }
  
  fs.writeFileSync(PID_FILE, pids.join('\n'));
  return pids;
}

export async function stopWorkers() {
  if (!fs.existsSync(PID_FILE)) {
    return;
  }
  
  const pids = fs.readFileSync(PID_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(p => parseInt(p));
  
  pids.forEach(pid => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
    }
  });
  
  fs.unlinkSync(PID_FILE);
}

export async function runWorker() {
  const workerId = `worker-${process.pid}`;
  let isRunning = true;

  process.on('SIGTERM', () => {
    console.log(`Worker ${workerId} shutting down gracefully...`);
    isRunning = false;
  });

  console.log(`Worker ${workerId} started`);

  while (isRunning) {
    try {
      const jobs = await db.getJobsToProcess();
      let jobProcessed = false;

      for (const job of jobs) {
        const locked = await db.lockJob(job.id, workerId);
        if (!locked) continue;

        jobProcessed = true;
        console.log(`Worker ${workerId} processing job ${job.id}`);

        await db.updateState(job.id, JobState.PROCESSING);

        try {
          const timeout = job.timeout || 30000;
          const result = await executeCommand(job.command, timeout);

          if (result.success) {
            await db.completeJob(job.id, result.output || '', result.duration);
            console.log(`Worker ${workerId} completed job ${job.id}`);
          } else {
            throw new Error(result.error || 'Command failed');
          }
        } catch (error: any) {
          const attempts = job.attempts + 1;
          const maxRetries = job.maxRetries;

          console.error(`Worker ${workerId} job ${job.id} failed: ${error.message}`);

          if (attempts <= maxRetries) {
            await db.scheduleRetry(job.id, attempts, error.message);
            console.log(`Worker ${workerId} scheduled retry for job ${job.id} (attempt ${attempts}/${maxRetries})`);
          } else {
            await db.moveToDLQ(job.id, error.message);
            console.log(`Worker ${workerId} moved job ${job.id} to DLQ after ${attempts} attempts`);
          }
        } finally {
          await db.unlockJob(job.id);
        }

        break;
      }

      if (!jobProcessed) {
        await sleep(1000);
      }
    } catch (error) {
      console.error(`Worker ${workerId} error:`, error);
      await sleep(1000);
    }
  }

  console.log(`Worker ${workerId} stopped`);
}

async function executeCommand(command: string, timeoutMs: number): Promise<{
  success: boolean;
  output?: string;
  error?: string;
  duration?: number;
}> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const [cmd, ...args] = command.split(' ');
    const child = spawn(cmd, args, { shell: true });

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    };

    timeoutId = setTimeout(() => {
      cleanup();
      const duration = Date.now() - startTime;
      resolve({ 
        success: false, 
        error: `Job timed out after ${timeoutMs}ms`,
        duration 
      });
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      cleanup();
      const duration = Date.now() - startTime;
      if (code === 0) {
        resolve({ success: true, output: stdout, duration });
      } else {
        resolve({ success: false, error: stderr || `Exit code ${code}`, duration });
      }
    });

    child.on('error', (err) => {
      cleanup();
      const duration = Date.now() - startTime;
      resolve({ success: false, error: err.message, duration });
    });
  });
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (require.main === module) {
  runWorker().catch(console.error);
}
