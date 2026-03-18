import { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

interface JobStatus {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress: number;
  error: string | null;
  payload: { originalName?: string };
}

export function useJobPolling(jobIds: string[], token: string | null, onAllDone: () => void) {
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const onAllDoneRef = useRef(onAllDone);
  onAllDoneRef.current = onAllDone;
  const firedRef = useRef(false);

  useEffect(() => {
    if (jobIds.length === 0) { firedRef.current = false; return; }

    const poll = async () => {
      const results = await Promise.all(
        jobIds.map(id =>
          fetch(`${API_BASE}/api/jobs/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.json())
        )
      );
      const map: Record<string, JobStatus> = {};
      results.forEach((j: JobStatus) => { map[j.id] = j; });
      setStatuses(map);

      const allDone = results.every(j => j.status === 'done' || j.status === 'error');
      if (allDone && !firedRef.current) {
        firedRef.current = true;
        onAllDoneRef.current();
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [jobIds.join(','), token]);

  return statuses;
}
