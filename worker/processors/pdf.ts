import { Job, queue } from '../queue.js';
import { analyzeText } from '../pipeline.js';
import { extractText } from './pdfExtract.js';
import path from 'path';

export async function processPdfJob(job: Job): Promise<void> {
  const { filePath, originalName } = job.payload;

  await queue.setProgress(job.id, 5);

  // Extract text from file
  const text = await extractText(filePath);
  await queue.setProgress(job.id, 20);

  // Generate a doc_id from the filename
  const docId = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  // Analyze with Claude
  const result = await analyzeText({
    projectId: job.project_id,
    docId,
    filePath,
    content: text,
    originalName
  });

  await queue.setDone(job.id, result);
}
