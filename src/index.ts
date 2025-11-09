#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { z } from 'zod';
import { db } from './db';
import { startWorkers, stopWorkers } from './worker';
import { JobState } from '@prisma/client';

const JobInput = z.object({
  id: z.string().optional(),
  command: z.string().min(1, 'Command cannot be empty'),
  max_retries: z.number().min(0).max(10).optional(),
  priority: z.number().min(0).max(100).optional(),
  timeout: z.number().min(1000).optional(),
  run_at: z.string().optional(),
});

const program = new Command();

program
  .name('queuectl')
  .description('Job queue system with PostgreSQL, retry, and DLQ')

program
  .command('enqueue <job>')
  .description('Add a new job')
  .action(async (jobJson: string) => {
    try {
      const input = JobInput.parse(JSON.parse(jobJson));
      
      if (input.id) {
        const existing = await db.getJobById(input.id);
        if (existing) {
          console.error(chalk.red(`Error: Job with id "${input.id}" already exists`));
          process.exit(1);
        }
      }
      
      const job = await db.createJob(input);
      console.log(chalk.green(`Job ${job.id} enqueued`));
    } catch (error: any) {
      if (error.code === 'P2002' && error.meta?.target?.includes('id')) {
        console.error(chalk.red(`Error: Job with this id already exists`));
      } else {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

const workerCmd = program.command('worker').description('Manage workers');

workerCmd
  .command('start')
  .option('-c, --count <number>', 'Number of workers', '1')
  .description('Start workers')
  .action(async (options) => {
    const count = parseInt(options.count);
    const pids = await startWorkers(count);
    console.log(chalk.green(`Started ${count} worker(s)`));
    pids.forEach((pid, i) => {
      console.log(chalk.gray(`  Worker ${i + 1} (PID: ${pid})`));
    });
  });

workerCmd
  .command('stop')
  .description('Stop all workers')
  .action(async () => {
    await stopWorkers();
    console.log(chalk.green('Workers stopped'));
  });

program
  .command('status')
  .description('Show queue status')
  .action(async () => {
    const stats = await db.getStats();
    
    console.log(chalk.bold.blue('\nQueue Status\n'));
    
    const table = new Table({
      head: [chalk.cyan('State'), chalk.cyan('Count'), chalk.cyan('%')]
    });
    
    const total = stats.total;
    const states = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD'];
    
    states.forEach(state => {
      const count = stats.byState[state] || 0;
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      table.push([state, count, `${pct}%`]);
    });
    
    console.log(table.toString());
    console.log(chalk.gray(`\nTotal: ${total} jobs`));
    if (stats.avgDuration > 0) {
      console.log(chalk.gray(`Avg Duration: ${(stats.avgDuration / 1000).toFixed(2)}s\n`));
    } else {
      console.log();
    }
  });

program
  .command('list')
  .option('-s, --state <state>', 'Filter by state')
  .description('List jobs')
  .action(async (options) => {
    try {
      let jobs;
      
      if (options.state) {
        const state = options.state.toUpperCase();
        const validStates = Object.values(JobState);
        
        if (!validStates.includes(state as JobState)) {
          console.error(chalk.red(`Error: Invalid state "${state}". Valid states are: ${validStates.join(', ')}`));
          process.exit(1);
        }
        
        jobs = await db.getJobsByState(state);
      } else {
        jobs = await db.getAllJobs();
      }
      
      if (jobs.length === 0) {
        console.log(chalk.yellow('No jobs found'));
        return;
      }
      
      const table = new Table({
        head: [chalk.cyan('ID'), chalk.cyan('Command'), chalk.cyan('State'), chalk.cyan('Attempts')]
      });
      
      jobs.forEach(job => {
        table.push([
          job.id.slice(0, 8),
          job.command.slice(0, 30),
          job.state,
          `${job.attempts}/${job.maxRetries}`
        ]);
      });
      
      console.log(table.toString());
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

const dlqCmd = program.command('dlq').description('Manage Dead Letter Queue');

dlqCmd
  .command('list')
  .description('View dead jobs')
  .action(async () => {
    const jobs = await db.getDLQJobs();
    
    if (jobs.length === 0) {
      console.log(chalk.green('DLQ is empty'));
      return;
    }
    
    const table = new Table({
      head: [chalk.cyan('ID'), chalk.cyan('Command'), chalk.cyan('Error')]
    });
    
    jobs.forEach(job => {
      table.push([
        job.id.slice(0, 8),
        job.command.slice(0, 30),
        (job.error || 'Unknown').slice(0, 40)
      ]);
    });
    
    console.log(chalk.red('\nDead Letter Queue\n'));
    console.log(table.toString());
  });

dlqCmd
  .command('retry <jobId>')
  .description('Retry a dead job')
  .action(async (jobId: string) => {
    try {
      await db.retryFromDLQ(jobId);
      console.log(chalk.green(`Job ${jobId} back in queue`));
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set config')
  .action(async (key: string, value: string) => {
    await db.setConfig(key, value);
    console.log(chalk.green(`${key} = ${value}`));
  });

configCmd
  .command('get <key>')
  .description('Get config')
  .action(async (key: string) => {
    const value = await db.getConfig(key);
    console.log(`${key} = ${value || 'not set'}`);
  });

program
  .command('dashboard')
  .description('Start web dashboard')
  .action(async () => {
    const { default: startDashboard } = await import('./dashboard');
    startDashboard();
  });

program
  .command('show <jobId>')
  .description('Show job details and output')
  .action(async (jobId: string) => {
    try {
      const job = await db.getJobById(jobId);
      if (!job) {
        console.error(chalk.red(`Job ${jobId} not found`));
        process.exit(1);
      }
      
      console.log(chalk.bold.blue(`\nJob ${job.id}\n`));
      console.log(chalk.cyan('Command:'), job.command);
      console.log(chalk.cyan('State:'), job.state);
      console.log(chalk.cyan('Attempts:'), `${job.attempts}/${job.maxRetries}`);
      if (job.priority) console.log(chalk.cyan('Priority:'), job.priority);
      if (job.timeout) console.log(chalk.cyan('Timeout:'), `${job.timeout}ms`);
      if (job.runAt) console.log(chalk.cyan('Run At:'), new Date(job.runAt).toLocaleString());
      if (job.duration) console.log(chalk.cyan('Duration:'), `${(job.duration / 1000).toFixed(2)}s`);
      if (job.output) {
        console.log(chalk.cyan('\nOutput:'));
        console.log(job.output);
      }
      if (job.error) {
        console.log(chalk.red('\nError:'));
        console.log(job.error);
      }
      console.log();
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program.parse();
