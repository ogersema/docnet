import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  doc_count: number;
  triple_count: number;
}

export default function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetch(`${API_BASE}/api/projects`, { headers })
      .then(r => r.json())
      .then(setProjects)
      .finally(() => setLoading(false));
  }, [token]);

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: 'POST', headers, body: JSON.stringify({ name: newName, description: newDesc }),
    });
    if (res.ok) {
      const project = await res.json();
      setProjects(prev => [{ ...project, doc_count: 0, triple_count: 0 }, ...prev]);
      setShowNew(false); setNewName(''); setNewDesc('');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">DocNet</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-400 text-sm">{user?.email}</span>
          <button onClick={logout} className="text-sm text-gray-400 hover:text-white">Sign out</button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">Projects</h2>
          <button onClick={() => setShowNew(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium transition-colors">
            New Project
          </button>
        </div>

        {showNew && (
          <form onSubmit={createProject} className="mb-6 p-4 bg-gray-800 rounded-lg space-y-3">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Project name"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500" autoFocus />
            <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500" />
            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium">Create</button>
              <button type="button" onClick={() => setShowNew(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">Cancel</button>
            </div>
          </form>
        )}

        <div className="space-y-3">
          {projects.map(p => (
            <div key={p.id} onClick={() => navigate(`/projects/${p.id}`)}
              className="p-4 bg-gray-800 hover:bg-gray-750 rounded-lg cursor-pointer transition-colors border border-gray-700 hover:border-gray-600">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-lg">{p.name}</h3>
                <span className="text-xs text-gray-500">{new Date(p.created_at).toLocaleDateString()}</span>
              </div>
              {p.description && <p className="text-gray-400 text-sm mt-1">{p.description}</p>}
              <div className="flex gap-4 mt-2 text-xs text-gray-500">
                <span>{p.doc_count} documents</span>
                <span>{p.triple_count} triples</span>
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-gray-500 text-center py-8">No projects yet. Create one to get started.</p>
          )}
        </div>
      </main>
    </div>
  );
}
