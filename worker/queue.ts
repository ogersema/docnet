import { pool } from '../db/pool.js';

export interface Job {
  id: string;
  project_id: string;
  type: 'pdf' | 'web';
  status: 'pending' | 'running' | 'done' | 'error';
  payload: Record<string, any>;
  progress: number;
  result: any;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export const queue = {
  async enqueue(params: { projectId: string; type: 'pdf' | 'web'; payload: object }): Promise<Job> {
    const { rows } = await pool.query(
      `INSERT INTO jobs (project_id, type, payload)
       VALUES ($1, $2, $3) RETURNING *`,
      [params.projectId, params.type, JSON.stringify(params.payload)]
    );
    return rowToJob(rows[0]);
  },

  async claim(): Promise<Job | null> {
    const { rows } = await pool.query(`
      UPDATE jobs SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    return rows[0] ? rowToJob(rows[0]) : null;
  },

  async setProgress(jobId: string, progress: number): Promise<void> {
    await pool.query(
      'UPDATE jobs SET progress = $1 WHERE id = $2',
      [Math.min(100, Math.max(0, progress)), jobId]
    );
  },

  async setDone(jobId: string, result?: object): Promise<void> {
    await pool.query(
      `UPDATE jobs SET status = 'done', progress = 100,
       result = $1, completed_at = NOW() WHERE id = $2`,
      [result ? JSON.stringify(result) : null, jobId]
    );
  },

  async setError(jobId: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE jobs SET status = 'error', error = $1, completed_at = NOW() WHERE id = $2`,
      [error, jobId]
    );
  },

  async getJob(jobId: string): Promise<Job | null> {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return rows[0] ? rowToJob(rows[0]) : null;
  },

  async listForProject(projectId: string, limit = 20): Promise<Job[]> {
    const { rows } = await pool.query(
      `SELECT * FROM jobs WHERE project_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return rows.map(rowToJob);
  }
};

function rowToJob(row: any): Job {
  return {
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    result: row.result && typeof row.result === 'string' ? JSON.parse(row.result) : row.result,
  };
}
