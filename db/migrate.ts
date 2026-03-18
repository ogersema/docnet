import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  // Create migrations tracking table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    const { rows } = await pool.query(
      'SELECT version FROM schema_migrations WHERE version = $1', [version]
    );
    if (rows.length > 0) {
      console.log(`  Skipping ${version} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    console.log(`  Applied ${version}`);
  }

  await pool.end();
  console.log('Migrations complete.');
}

migrate().catch(err => { console.error(err); process.exit(1); });
