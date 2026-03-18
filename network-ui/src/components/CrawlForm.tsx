import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

interface CrawlFormProps {
  projectId: string;
  onComplete: () => void;
}

interface JobStatus {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress: number;
  result?: { pagesFound: number; pagesAnalyzed: number; startUrl: string };
  error?: string;
}

export default function CrawlForm({ projectId, onComplete }: CrawlFormProps) {
  const { token } = useAuth();
  const [url, setUrl] = useState('');
  const [maxDepth, setMaxDepth] = useState(0);
  const [maxPages, setMaxPages] = useState(50);
  const [domainOnly, setDomainOnly] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const pollJob = (jobId: string) => {
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const job: JobStatus = await res.json();
        setActiveJob(job);

        if (job.status === 'done' || job.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (job.status === 'done') {
            onComplete();
          }
        }
      } catch {}
    }, 3000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setActiveJob(null);

    // Basic URL validation
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setError('Only http and https URLs are supported');
        return;
      }
    } catch {
      setError('Please enter a valid URL (e.g. https://example.com)');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/crawl`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ url, maxDepth, domainOnly, maxPages })
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to start crawl');
        return;
      }

      const data = await res.json();
      setActiveJob({ id: data.jobId, status: 'pending', progress: 0 });
      pollJob(data.jobId);
      setUrl('');
    } catch (err: any) {
      setError(err.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
            disabled={submitting}
            required
          />
        </div>

        <div className="flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Depth:</span>
            <select
              value={maxDepth}
              onChange={(e) => setMaxDepth(parseInt(e.target.value))}
              className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white"
              disabled={submitting}
            >
              <option value={0}>This page only</option>
              <option value={1}>Linked pages</option>
              <option value={2}>Two levels deep</option>
              <option value={3}>Three levels deep</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <span className="text-gray-400">Max pages:</span>
            <input
              type="number"
              value={maxPages}
              onChange={(e) => setMaxPages(Math.min(200, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-16 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white"
              min={1}
              max={200}
              disabled={submitting}
            />
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={domainOnly}
              onChange={(e) => setDomainOnly(e.target.checked)}
              className="rounded"
              disabled={submitting}
            />
            <span className="text-gray-400">Same domain only</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={submitting || !url}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white text-sm rounded transition-colors"
        >
          {submitting ? 'Starting...' : 'Analyse Website'}
        </button>
      </form>

      {error && (
        <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded px-3 py-2">
          {error}
        </div>
      )}

      {activeJob && (
        <div className="bg-gray-700/50 rounded px-3 py-2 text-sm">
          {activeJob.status === 'pending' && (
            <span className="text-yellow-400">Waiting to start...</span>
          )}
          {activeJob.status === 'running' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-blue-400">
                  Crawling... {activeJob.progress <= 50 ? '(fetching pages)' : '(analyzing)'}
                </span>
                <span className="text-gray-400">{activeJob.progress}%</span>
              </div>
              <div className="w-full bg-gray-600 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${activeJob.progress}%` }}
                />
              </div>
            </div>
          )}
          {activeJob.status === 'done' && activeJob.result && (
            <span className="text-green-400">
              Done: Analyzed {activeJob.result.pagesAnalyzed} of {activeJob.result.pagesFound} pages
            </span>
          )}
          {activeJob.status === 'error' && (
            <span className="text-red-400">Error: {activeJob.error}</span>
          )}
        </div>
      )}
    </div>
  );
}
