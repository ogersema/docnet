import { useState, useRef, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useJobPolling } from '../hooks/useJobs';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

interface UploadZoneProps {
  projectId: string;
  onComplete: () => void;
}

export default function UploadZone({ projectId, onComplete }: UploadZoneProps) {
  const { token } = useAuth();
  const [dragging, setDragging] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const statuses = useJobPolling(jobIds, token, onComplete);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    setError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('files', f));

      const res = await fetch(`${API_BASE}/api/projects/${projectId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Upload failed');
        return;
      }

      const data = await res.json();
      setJobIds(data.jobs.map((j: any) => j.id));
    } catch {
      setError('Network error during upload');
    } finally {
      setUploading(false);
    }
  }, [projectId, token]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const allDone = jobIds.length > 0 && Object.values(statuses).length === jobIds.length &&
    Object.values(statuses).every(s => s.status === 'done' || s.status === 'error');

  return (
    <div className="mb-4">
      <div
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
          ${dragging ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 hover:border-gray-500'}
          ${uploading ? 'opacity-50 pointer-events-none' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.csv,.xlsx,.xls"
          className="hidden"
          onChange={e => e.target.files && uploadFiles(e.target.files)}
        />
        <p className="text-gray-400 text-sm">
          {uploading ? 'Uploading...' : 'Drop files here or click to browse'}
        </p>
      </div>

      {error && (
        <div className="mt-2 text-red-400 text-sm bg-red-900/30 rounded px-3 py-2">{error}</div>
      )}

      {jobIds.length > 0 && (
        <div className="mt-3 space-y-2">
          {jobIds.map(id => {
            const s = statuses[id];
            if (!s) return null;
            return (
              <div key={id} className="flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="truncate text-gray-300">{s.payload?.originalName || id.slice(0, 8)}</div>
                  <div className="w-full bg-gray-700 rounded-full h-1.5 mt-1">
                    <div
                      className={`h-1.5 rounded-full transition-all ${
                        s.status === 'error' ? 'bg-red-500' : s.status === 'done' ? 'bg-green-500' : 'bg-blue-500'
                      }`}
                      style={{ width: `${s.progress}%` }}
                    />
                  </div>
                </div>
                <span className={`text-xs whitespace-nowrap ${
                  s.status === 'error' ? 'text-red-400' : s.status === 'done' ? 'text-green-400' : 'text-blue-400'
                }`}>
                  {s.status === 'error' ? s.error?.slice(0, 30) : s.status === 'done' ? 'Done' : `${s.progress}%`}
                </span>
              </div>
            );
          })}
          {allDone && (
            <button
              onClick={() => setJobIds([])}
              className="text-xs text-gray-500 hover:text-gray-300 mt-1"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
