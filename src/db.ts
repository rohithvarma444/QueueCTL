import { PrismaClient, JobState } from '@prisma/client';

const prisma = new PrismaClient();

export const db = {
  async createJob(data: any) {
    const jobData: any = {
      command: data.command,
      maxRetries: data.max_retries || 3,
      priority: data.priority || 0,
      timeout: data.timeout || 30000,
      state: JobState.PENDING,
    };
    
    if (data.id) {
      jobData.id = data.id;
    }
    
    if (data.run_at) {
      jobData.runAt = new Date(data.run_at);
    }
    
    return prisma.job.create({
      data: jobData,
    });
  },

  async getJobsToProcess() {
    const now = new Date();
    return prisma.job.findMany({
      where: {
        AND: [
          {
            OR: [
              { state: JobState.PENDING },
              { 
                state: JobState.FAILED,
                nextRetryAt: { lte: now }
              },
            ],
          },
          { lockedBy: null },
          {
            OR: [
              { runAt: null },
              { runAt: { lte: now } }
            ]
          }
        ],
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'asc' }
      ],
      take: 10,
    });
  },

  async lockJob(jobId: string, workerId: string) {
    const result = await prisma.job.updateMany({
      where: {
        id: jobId,
        lockedBy: null,
      },
      data: {
        lockedBy: workerId,
        lockedAt: new Date(),
      },
    });
    return result.count > 0;
  },

  async unlockJob(jobId: string) {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        lockedBy: null,
        lockedAt: null,
      },
    });
  },

  async updateState(jobId: string, state: JobState) {
    return prisma.job.update({
      where: { id: jobId },
      data: { 
        state,
        startedAt: state === JobState.PROCESSING ? new Date() : undefined
      },
    });
  },

  async completeJob(jobId: string, output: string, duration?: number) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    const finalDuration = duration || (job?.startedAt ? Date.now() - job.startedAt.getTime() : 0);
    
    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        state: JobState.COMPLETED,
        output,
        completedAt: new Date(),
        duration: finalDuration,
      },
    });
    
    await this.recordMetric('job_duration', finalDuration);
    await this.recordMetric('job_completed', 1);
    
    return updated;
  },

  async scheduleRetry(jobId: string, attempts: number, error: string) {
    const backoffBase = parseInt(await this.getConfig('backoff_base') || '2');
    const delaySeconds = Math.pow(backoffBase, attempts);
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

    return prisma.job.update({
      where: { id: jobId },
      data: {
        state: JobState.FAILED,
        attempts,
        nextRetryAt,
        error,
      },
    });
  },

  async moveToDLQ(jobId: string, error: string) {
    await this.recordMetric('job_failed', 1);
    return prisma.job.update({
      where: { id: jobId },
      data: {
        state: JobState.DEAD,
        error,
      },
    });
  },


  async getJobsByState(state: string) {
    const validStates = Object.values(JobState);
    if (!validStates.includes(state as JobState)) {
      throw new Error(`Invalid state: ${state}. Valid states are: ${validStates.join(', ')}`);
    }
    return prisma.job.findMany({
      where: { state: state as JobState },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getAllJobs() {
    return prisma.job.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },

  async getJobById(id: string) {
    return prisma.job.findUnique({
      where: { id },
    });
  },

  async findJobByIdOrPartial(partialId: string) {
    // First try exact match
    const exactMatch = await prisma.job.findUnique({
      where: { id: partialId },
    });
    if (exactMatch) {
      return exactMatch;
    }

    // If no exact match, try partial match (jobs starting with the given ID)
    // Using Prisma's string filter for pattern matching
    const jobs = await prisma.job.findMany({
      where: {
        id: {
          startsWith: partialId,
        },
      },
      take: 2, // Only fetch 2 to check for multiple matches
    });

    if (jobs.length === 0) {
      return null;
    }

    if (jobs.length > 1) {
      throw new Error(`Multiple jobs found matching "${partialId}". Please use a longer ID to be more specific.`);
    }

    return jobs[0];
  },

  async getDLQJobs() {
    return prisma.job.findMany({
      where: { state: JobState.DEAD },
      orderBy: { updatedAt: 'desc' },
    });
  },

  async retryFromDLQ(jobId: string) {
    // Find job by full or partial ID
    const job = await this.findJobByIdOrPartial(jobId);
    
    if (!job) {
      throw new Error(`Job "${jobId}" not found.`);
    }

    // Validate job is in DEAD state
    if (job.state !== JobState.DEAD) {
      throw new Error(`Job ${job.id} is not in DEAD state (current state: ${job.state}). Only dead jobs can be retried from DLQ.`);
    }

    return prisma.job.update({
      where: { id: job.id },
      data: {
        state: JobState.PENDING,
        attempts: 0,
        nextRetryAt: null,
        error: null,
      },
    });
  },

  async getConfig(key: string) {
    const config = await prisma.config.findUnique({
      where: { key },
    });
    return config?.value || null;
  },

  async setConfig(key: string, value: string) {
    await prisma.config.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  },

  async recordMetric(type: string, value: number) {
    await prisma.metric.create({
      data: { type, value },
    });
  },

  async getMetrics(type: string, hours: number = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return prisma.metric.findMany({
      where: {
        type,
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
    });
  },

  async getStats() {
    const jobs = await prisma.job.findMany();
    const total = jobs.length;
    
    const byState = jobs.reduce((acc, job) => {
      acc[job.state] = (acc[job.state] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const completed = jobs.filter(j => j.state === JobState.COMPLETED);
    const avgDuration = completed.length > 0
      ? completed.reduce((sum, j) => sum + (j.duration || 0), 0) / completed.length
      : 0;

    return { total, byState, avgDuration };
  },
};
