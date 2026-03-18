import { Router } from 'express';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { signToken } from '../auth/tokens.js';
import { authMiddleware } from '../auth/middleware.js';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password, displayName required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id, email, display_name, role`,
      [email.toLowerCase(), hash, displayName]
    );
    const user = rows[0];

    // Create a default first project
    await pool.query(
      `INSERT INTO projects (user_id, name, description)
       VALUES ($1, $2, $3)`,
      [user.id, 'My first project', 'Default project created on registration']
    );

    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    res.status(201).json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email address already registered' });
    }
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, display_name, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me  (verify current token)
router.get('/me', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, display_name, role FROM users WHERE id = $1',
    [req.user!.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const u = rows[0];
  res.json({ id: u.id, email: u.email, displayName: u.display_name, role: u.role });
});

export default router;
