import type { Stats, Relationship, Actor, TagCluster } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? 'http://localhost:3001/api' : '/api');

// Current project context — set by ProjectDetail page
let currentProjectId: string | null = null;
let currentToken: string | null = null;

export function setApiContext(projectId: string | null, token: string | null) {
  currentProjectId = projectId;
  currentToken = token;
}

function projectBase(): string {
  if (!currentProjectId) return API_BASE;
  return `${API_BASE}/projects/${currentProjectId}`;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (currentToken) h['Authorization'] = `Bearer ${currentToken}`;
  return h;
}

export async function fetchStats(): Promise<Stats> {
  const response = await fetch(`${projectBase()}/stats`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch stats');
  return response.json();
}

export async function fetchTagClusters(): Promise<TagCluster[]> {
  const response = await fetch(`${projectBase()}/tag-clusters`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch tag clusters');
  return response.json();
}

export async function fetchRelationships(limit: number = 500, clusterIds: number[] = [], categories: string[] = [], yearRange?: [number, number], includeUndated: boolean = true, keywords: string = '', maxHops?: number | null): Promise<{ relationships: Relationship[], totalBeforeLimit: number, totalBeforeFilter: number }> {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (clusterIds.length > 0) params.append('clusters', clusterIds.join(','));
  if (categories.length > 0) params.append('categories', categories.join(','));
  if (yearRange) {
    params.append('yearMin', yearRange[0].toString());
    params.append('yearMax', yearRange[1].toString());
  }
  params.append('includeUndated', includeUndated.toString());
  if (keywords.trim()) params.append('keywords', keywords.trim());
  if (maxHops !== undefined && maxHops !== null) params.append('maxHops', maxHops.toString());
  const response = await fetch(`${projectBase()}/relationships?${params}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch relationships');
  return response.json();
}

export async function fetchActorRelationships(name: string, clusterIds: number[] = [], categories: string[] = [], yearRange?: [number, number], includeUndated: boolean = true, keywords: string = '', maxHops?: number | null): Promise<{ relationships: Relationship[], totalBeforeFilter: number }> {
  const params = new URLSearchParams();
  if (clusterIds.length > 0) params.append('clusters', clusterIds.join(','));
  if (categories.length > 0) params.append('categories', categories.join(','));
  if (yearRange) {
    params.append('yearMin', yearRange[0].toString());
    params.append('yearMax', yearRange[1].toString());
  }
  params.append('includeUndated', includeUndated.toString());
  if (keywords.trim()) params.append('keywords', keywords.trim());
  if (maxHops !== undefined && maxHops !== null) params.append('maxHops', maxHops.toString());
  const url = `${projectBase()}/actor/${encodeURIComponent(name)}/relationships${params.toString() ? '?' + params : ''}`;
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch actor relationships');
  return response.json();
}

export async function searchActors(query: string): Promise<Actor[]> {
  const response = await fetch(`${projectBase()}/search?q=${encodeURIComponent(query)}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to search actors');
  return response.json();
}

export async function fetchDocument(docId: string): Promise<import('./types').Document> {
  const response = await fetch(`${projectBase()}/document/${encodeURIComponent(docId)}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch document');
  return response.json();
}

export async function fetchDocumentText(docId: string): Promise<{ text: string }> {
  const response = await fetch(`${projectBase()}/document/${encodeURIComponent(docId)}/text`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch document text');
  return response.json();
}

export async function fetchActorCounts(limit: number = 300): Promise<Record<string, number>> {
  const params = new URLSearchParams({ limit: limit.toString() });
  const response = await fetch(`${projectBase()}/actor-counts?${params}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch actor counts');
  return response.json();
}

export async function fetchActorCount(name: string): Promise<number> {
  const url = `${projectBase()}/actor/${encodeURIComponent(name)}/count`;
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch actor count');
  const data = await response.json();
  return data.count;
}
