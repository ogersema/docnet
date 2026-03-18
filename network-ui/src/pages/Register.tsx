import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Registration failed'); return; }
      login(data.token, data.user);
      navigate('/projects');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">DocNet</h1>
          <p className="mt-2 text-gray-400">Create your account</p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          {error && <div className="bg-red-900/50 border border-red-500 text-red-300 px-4 py-3 rounded">{error}</div>}
          <div className="space-y-4">
            <div>
              <label htmlFor="displayName" className="text-sm text-gray-300">Display Name</label>
              <input id="displayName" type="text" required value={displayName} onChange={e => setDisplayName(e.target.value)}
                className="mt-1 block w-full rounded bg-gray-800 border border-gray-700 text-white px-3 py-2 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label htmlFor="email" className="text-sm text-gray-300">Email</label>
              <input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
                className="mt-1 block w-full rounded bg-gray-800 border border-gray-700 text-white px-3 py-2 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label htmlFor="password" className="text-sm text-gray-300">Password (min 8 characters)</label>
              <input id="password" type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)}
                className="mt-1 block w-full rounded bg-gray-800 border border-gray-700 text-white px-3 py-2 focus:outline-none focus:border-blue-500" />
            </div>
          </div>
          <button type="submit" disabled={loading}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded font-medium transition-colors">
            {loading ? 'Creating account...' : 'Create account'}
          </button>
          <p className="text-center text-gray-400 text-sm">
            Already have an account? <Link to="/login" className="text-blue-400 hover:text-blue-300">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
