import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

interface WebSource {
  id: string;
  url: string;
  title: string;
  doc_count: number;
  crawled_at: string;
}

interface SourceListProps {
  projectId: string;
  refreshKey?: number;
}

export default function SourceList({ projectId, refreshKey }: SourceListProps) {
  const { token } = useAuth();
  const [sources, setSources] = useState<WebSource[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/crawl/sources`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          setSources(await res.json());
        }
      } catch {}
      setLoading(false);
    };
    load();
  }, [projectId, token, refreshKey]);

  if (loading) return null;
  if (sources.length === 0) return null;

  return (
    <div className="text-sm">
      <h4 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">Crawled Sources</h4>
      <div className="space-y-1">
        {sources.map((s) => {
          const domain = (() => { try { return new URL(s.url).hostname; } catch { return s.url; } })();
          const date = new Date(s.crawled_at).toLocaleDateString();
          return (
            <div key={s.id} className="flex items-center justify-between bg-gray-700/30 rounded px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 truncate block"
                  title={s.url}
                >
                  {s.title || domain}
                </a>
                <span className="text-gray-500 text-xs">{date} &middot; {s.doc_count} pages</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
