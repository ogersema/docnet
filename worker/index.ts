import 'dotenv/config';
import { queue } from './queue.js';
import { processPdfJob } from './processors/pdf.js';
import { processWebJob } from './processors/web.js';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processJob(job: any) {
  switch (job.type) {
    case 'pdf': return processPdfJob(job);
    case 'web': return processWebJob(job);
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

async function runWorker() {
  console.log('Analysis worker started. Waiting for jobs...');

  while (true) {
    try {
      const job = await queue.claim();
      if (!job) {
        await sleep(2000);
        continue;
      }

      console.log(`Processing job ${job.id} (type: ${job.type}, project: ${job.project_id})`);

      try {
        await processJob(job);
        console.log(`Job ${job.id} completed`);
      } catch (err: any) {
        console.error(`Job ${job.id} failed:`, err.message);
        await queue.setError(job.id, err.message);
      }
    } catch (err) {
      console.error('Worker loop error:', err);
      await sleep(5000);
    }
  }
}

runWorker();
