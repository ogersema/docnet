export interface RelationshipParams {
  limit: number;
  clusterIds: number[];
  categories: string[];
  yearRange?: [number, number] | null;
  includeUndated: boolean;
  keywords: string[];
  maxHops?: number | null;
}

export interface RelationshipRow {
  id: number;
  doc_id: string;
  timestamp: string | null;
  actor: string;
  action: string;
  target: string;
  location: string | null;
  triple_tags: string | null;
  top_cluster_ids: string | null;
}

export interface RelationshipResult {
  relationships: any[];
  totalBeforeLimit: number;
  totalBeforeFilter: number;
}

export interface ActorRelationshipResult {
  relationships: any[];
  totalBeforeFilter: number;
}

export interface IStorageAdapter {
  getStats(): any;
  getTagClusters(): any[];
  getRelationships(params: RelationshipParams): RelationshipResult;
  getActorRelationships(name: string, params: RelationshipParams): ActorRelationshipResult;
  searchActors(query: string): any[];
  getActorCount(name: string): number;
  getActorCounts(limit: number): Record<string, number>;
  getDocument(docId: string): any | null;
  getDocumentText(docId: string): string | null;
  close(): void;
}
