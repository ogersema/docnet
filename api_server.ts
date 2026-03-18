#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { pool } from './db/pool.js';
import authRouter from './routes/auth.js';
import projectsRouter from './routes/projects.js';
import graphRouter from './routes/graph.js';
import uploadRouter from './routes/upload.js';
import crawlRouter from './routes/crawl.js';
import projectJobsRouter from './routes/jobs.js';
import { jobsRouter } from './routes/jobs.js';

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.trim())
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

console.log('Allowed CORS origins:', ALLOWED_ORIGINS);

// CORS configuration with origin whitelist
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  maxAge: 86400
}));

app.use(express.json({ limit: '10mb' }));

// Request logging
const accessLogStream = process.env.ACCESS_LOG
  ? fs.createWriteStream(process.env.ACCESS_LOG, { flags: 'a' })
  : undefined;
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
  accessLogStream ? { stream: accessLogStream } : undefined
));

// Simple rate limiting middleware
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 1000;

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const userData = requestCounts.get(ip);
  if (!userData || now > userData.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  if (userData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }
  userData.count++;
  next();
});

// --- Routes ---

// Auth routes (public)
app.use('/api/auth', authRouter);

// Projects CRUD
app.use('/api/projects', projectsRouter);

// Upload endpoint
app.use('/api/projects/:projectId/upload', uploadRouter);

// Crawl endpoint
app.use('/api/projects/:projectId/crawl', crawlRouter);

// Job status endpoints
app.use('/api/projects/:projectId/jobs', projectJobsRouter);
app.use('/api/jobs', jobsRouter);

// Graph/analysis endpoints (nested under projects)
app.use('/api/projects/:projectId', graphRouter);

// Health check (both paths for nginx and direct access)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Serve static frontend files
const frontendPath = process.env.DIST_DIR || path.join(process.cwd(), 'network-ui', 'dist');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
  console.log(`Serving frontend from ${frontendPath}`);
} else {
  console.log(`Frontend build not found at ${frontendPath}`);
}

const server = app.listen(PORT, () => {
  console.log(`\nAPI Server running at http://localhost:${PORT}`);
});

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
  console.log(`\n${signal} received, closing server gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed');
    try {
      await pool.end();
      console.log('Database pool closed');
    } catch (error) {
      console.error('Error closing database pool:', error);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
