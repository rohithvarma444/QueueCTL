#!/usr/bin/env node

import express from 'express';
import { db } from './db';
import { JobState } from '@prisma/client';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const state = req.query.state as string;
    const jobs = state ? await db.getJobsByState(state) : await db.getAllJobs();
    res.json(jobs.slice(0, 100));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const type = req.query.type as string || 'job_duration';
    const hours = parseInt(req.query.hours as string) || 24;
    const metrics = await db.getMetrics(type, hours);
    res.json(metrics);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default function startDashboard() {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startDashboard();
}

