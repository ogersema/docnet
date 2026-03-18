import Database from 'better-sqlite3';
import type { DocNetConfig } from '../config';
import type {
  IStorageAdapter,
  RelationshipParams,
  RelationshipRow,
  RelationshipResult,
  ActorRelationshipResult,
} from './IStorageAdapter';

function calculateBM25Score(text: string, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0;
  const textLower = text.toLowerCase();
  const words = textLower.split(/\s+/);
  const docLength = words.length;
  const avgDocLength = 100;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  keywords.forEach(keyword => {
    const tf = words.filter(word => word.includes(keyword)).length;
    if (tf === 0) return;
    const idf = Math.log(10);
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
    score += idf * (numerator / denominator);
  });
  return score;
}

export class SqliteAdapter implements IStorageAdapter {
  private db: Database.Database;
  private tagClusters: any[];
  private config: DocNetConfig;

  constructor(dbPath: string, tagClusters: any[], config: DocNetConfig) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.tagClusters = tagClusters;
    this.config = config;
  }

  getStats(): any {
    return {
      totalDocuments: this.db.prepare('SELECT COUNT(*) as count FROM documents').get(),
      totalTriples: this.db.prepare('SELECT COUNT(*) as count FROM rdf_triples').get(),
      totalActors: this.db.prepare(`
        SELECT COUNT(DISTINCT COALESCE(ea.canonical_name, rt.actor)) as count
        FROM rdf_triples rt
        LEFT JOIN entity_aliases ea ON rt.actor = ea.original_name
      `).get(),
      categories: this.db.prepare(`
        SELECT category, COUNT(*) as count
        FROM documents
        GROUP BY category
        ORDER BY count DESC
      `).all(),
    };
  }

  getTagClusters(): any[] {
    return this.tagClusters.map((cluster: any) => ({
      id: cluster.id,
      name: cluster.name,
      exemplars: cluster.exemplars,
      tagCount: cluster.tags.length,
    }));
  }

  getRelationships(params: RelationshipParams): RelationshipResult {
    const { limit, clusterIds, categories, yearRange, includeUndated, keywords, maxHops } = params;
    const PRINCIPAL_NAME = this.config.principal.name;
    const selectedClusterIds = new Set<number>(clusterIds);
    const selectedCategories = new Set<string>(categories);
    const yearMin = this.config.analysis.yearRangeMin;

    let categoryWhere = '';
    let categoryParams: string[] = [];
    if (selectedCategories.size > 0) {
      const placeholders = Array.from(selectedCategories).map(() => '?').join(',');
      categoryWhere = `AND d.category IN (${placeholders})`;
      categoryParams = Array.from(selectedCategories);
    }

    let yearWhere = '';
    let yearParams: string[] = [];
    if (yearRange) {
      const [minYear, maxYear] = yearRange;
      if (includeUndated) {
        yearWhere = `AND (rt.timestamp IS NULL OR (CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= ? AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= ?))`;
      } else {
        yearWhere = `AND (rt.timestamp IS NOT NULL AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= ? AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= ?)`;
      }
      yearParams = [minYear.toString(), maxYear.toString()];
    }

    let hopJoins = '';
    let hopWhere = '';
    let hopParams: number[] = [];
    if (maxHops !== null && maxHops !== undefined && this.config.principal.hopFilterEnabled) {
      hopJoins = `
      LEFT JOIN canonical_entities ce_actor ON COALESCE(ea_actor.canonical_name, rt.actor) = ce_actor.canonical_name
      LEFT JOIN canonical_entities ce_target ON COALESCE(ea_target.canonical_name, rt.target) = ce_target.canonical_name`;
      hopWhere = `AND ce_actor.hop_distance_from_principal <= ?
                  AND ce_target.hop_distance_from_principal <= ?`;
      hopParams = [maxHops, maxHops];
    }

    const MAX_DB_LIMIT = 100000;
    const allRelationships = this.db.prepare(`
      SELECT
        rt.id,
        rt.doc_id,
        rt.timestamp,
        COALESCE(ea_actor.canonical_name, rt.actor) as actor,
        rt.action,
        COALESCE(ea_target.canonical_name, rt.target) as target,
        rt.location,
        rt.triple_tags,
        rt.top_cluster_ids
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name
      ${hopJoins}
      LEFT JOIN documents d ON rt.doc_id = d.doc_id
      WHERE (rt.timestamp IS NULL OR rt.timestamp >= '${yearMin}-01-01')
      ${categoryWhere}
      ${yearWhere}
      ${hopWhere}
      ORDER BY rt.timestamp
      LIMIT ?
    `).all(...categoryParams, ...yearParams, ...hopParams, MAX_DB_LIMIT) as RelationshipRow[];

    // Filter by tag clusters
    let filteredRelationships = allRelationships.filter(rel => {
      if (selectedClusterIds.size === 0) return true;
      try {
        const topClusters = rel.top_cluster_ids ? JSON.parse(rel.top_cluster_ids) : [];
        return topClusters.some((clusterId: number) => selectedClusterIds.has(clusterId));
      } catch {
        return false;
      }
    });

    // Filter by keywords
    if (keywords.length > 0) {
      filteredRelationships = filteredRelationships.filter(rel => {
        const searchText = `${rel.actor} ${rel.action} ${rel.target} ${rel.location || ''}`;
        return calculateBM25Score(searchText, keywords) > 0;
      });
    }

    // Build adjacency list for BFS
    const adjacency = new Map<string, Set<string>>();
    filteredRelationships.forEach(rel => {
      if (!adjacency.has(rel.actor)) adjacency.set(rel.actor, new Set());
      if (!adjacency.has(rel.target)) adjacency.set(rel.target, new Set());
      adjacency.get(rel.actor)!.add(rel.target);
      adjacency.get(rel.target)!.add(rel.actor);
    });

    // BFS to calculate distances from principal (if configured)
    const distances = new Map<string, number>();
    const queue: string[] = [];
    if (PRINCIPAL_NAME && adjacency.has(PRINCIPAL_NAME)) {
      distances.set(PRINCIPAL_NAME, 0);
      queue.push(PRINCIPAL_NAME);
      while (queue.length > 0) {
        const current = queue.shift()!;
        const currentDistance = distances.get(current)!;
        const neighbors = adjacency.get(current) || new Set();
        neighbors.forEach(neighbor => {
          if (!distances.has(neighbor)) {
            distances.set(neighbor, currentDistance + 1);
            queue.push(neighbor);
          }
        });
      }
    }

    // Deduplicate edges
    const edgeMap = new Map<string, any[]>();
    filteredRelationships.forEach(rel => {
      const edgeKey = `${rel.actor}|||${rel.target}`;
      if (!edgeMap.has(edgeKey)) edgeMap.set(edgeKey, []);
      edgeMap.get(edgeKey)!.push(rel);
    });

    const uniqueEdges = Array.from(edgeMap.entries()).map(([key, rels]) => ({
      edgeKey: key,
      relationships: rels,
      representative: rels[0],
    }));

    // Calculate node degrees
    const nodeDegrees = new Map<string, number>();
    uniqueEdges.forEach(edge => {
      const rel = edge.representative;
      nodeDegrees.set(rel.actor, (nodeDegrees.get(rel.actor) || 0) + 1);
      nodeDegrees.set(rel.target, (nodeDegrees.get(rel.target) || 0) + 1);
    });

    // Assign density score
    const edgesWithDensity = uniqueEdges.map(edge => {
      const rel = edge.representative;
      const actorDegree = nodeDegrees.get(rel.actor) || 0;
      const targetDegree = nodeDegrees.get(rel.target) || 0;
      return { ...edge, _density: actorDegree + targetDegree };
    });

    edgesWithDensity.sort((a, b) => b._density - a._density);
    const prunedEdges = edgesWithDensity.slice(0, limit);
    const prunedRelationships = prunedEdges.flatMap(edge => edge.relationships);

    const relationships = prunedRelationships.map(({ triple_tags, ...rel }) => ({
      ...rel,
      tags: triple_tags ? JSON.parse(triple_tags) : [],
    }));

    return {
      relationships,
      totalBeforeLimit: uniqueEdges.length,
      totalBeforeFilter: allRelationships.length,
    };
  }

  getActorRelationships(name: string, params: RelationshipParams): ActorRelationshipResult {
    const { clusterIds, categories, yearRange, includeUndated, keywords, maxHops } = params;
    const selectedClusterIds = new Set<number>(clusterIds);
    const selectedCategories = new Set<string>(categories);
    const yearMin = this.config.analysis.yearRangeMin;

    // Find all aliases for this name
    const aliasQuery = this.db.prepare(`
      SELECT original_name FROM entity_aliases WHERE canonical_name = ?
      UNION
      SELECT canonical_name FROM entity_aliases WHERE original_name = ?
      UNION
      SELECT ? as name
    `).all(name, name, name);

    const allNames = aliasQuery.map((row: any) => row.original_name || row.canonical_name || row.name);
    const placeholders = allNames.map(() => '?').join(',');

    // Total count without filters
    const totalRelationships = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM rdf_triples rt
      WHERE (rt.actor IN (${placeholders}) OR rt.target IN (${placeholders}))
        AND (rt.timestamp IS NULL OR rt.timestamp >= '${yearMin}-01-01')
    `).get(...allNames, ...allNames) as { count: number };

    let categoryWhere = '';
    let categoryParams: string[] = [];
    if (selectedCategories.size > 0) {
      const catPlaceholders = Array.from(selectedCategories).map(() => '?').join(',');
      categoryWhere = `AND d.category IN (${catPlaceholders})`;
      categoryParams = Array.from(selectedCategories);
    }

    let yearWhere = '';
    let yearParams: string[] = [];
    if (yearRange) {
      const [minYear, maxYear] = yearRange;
      if (includeUndated) {
        yearWhere = `AND (rt.timestamp IS NULL OR (CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= ? AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= ?))`;
      } else {
        yearWhere = `AND (rt.timestamp IS NOT NULL AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= ? AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= ?)`;
      }
      yearParams = [minYear.toString(), maxYear.toString()];
    }

    let hopJoins = '';
    let hopWhere = '';
    let hopParams: number[] = [];
    if (maxHops !== null && maxHops !== undefined && this.config.principal.hopFilterEnabled) {
      hopJoins = `
      LEFT JOIN canonical_entities ce_actor ON COALESCE(ea_actor.canonical_name, rt.actor) = ce_actor.canonical_name
      LEFT JOIN canonical_entities ce_target ON COALESCE(ea_target.canonical_name, rt.target) = ce_target.canonical_name`;
      hopWhere = `AND ce_actor.hop_distance_from_principal <= ?
                  AND ce_target.hop_distance_from_principal <= ?`;
      hopParams = [maxHops, maxHops];
    }

    const allRelationships = this.db.prepare(`
      SELECT
        rt.id,
        rt.doc_id,
        rt.timestamp,
        COALESCE(ea_actor.canonical_name, rt.actor) as actor,
        rt.action,
        COALESCE(ea_target.canonical_name, rt.target) as target,
        rt.location,
        rt.triple_tags,
        rt.top_cluster_ids
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name
      ${hopJoins}
      LEFT JOIN documents d ON rt.doc_id = d.doc_id
      WHERE (rt.actor IN (${placeholders}) OR rt.target IN (${placeholders}))
        AND (rt.timestamp IS NULL OR rt.timestamp >= '${yearMin}-01-01')
        ${categoryWhere}
        ${yearWhere}
        ${hopWhere}
      ORDER BY rt.timestamp
    `).all(...allNames, ...allNames, ...categoryParams, ...yearParams, ...hopParams) as RelationshipRow[];

    // Filter by tag clusters
    let filteredRelationships = allRelationships.filter(rel => {
      if (selectedClusterIds.size === 0) return true;
      try {
        const topClusters = rel.top_cluster_ids ? JSON.parse(rel.top_cluster_ids) : [];
        return topClusters.some((clusterId: number) => selectedClusterIds.has(clusterId));
      } catch {
        return false;
      }
    });

    // Filter by keywords
    if (keywords.length > 0) {
      filteredRelationships = filteredRelationships.filter(rel => {
        const searchText = `${rel.actor} ${rel.action} ${rel.target} ${rel.location || ''}`;
        return calculateBM25Score(searchText, keywords) > 0;
      });
    }

    const relationships = filteredRelationships.map((rel) => ({
      id: rel.id,
      doc_id: rel.doc_id,
      timestamp: rel.timestamp,
      actor: rel.actor,
      action: rel.action,
      target: rel.target,
      location: rel.location,
      tags: rel.triple_tags ? JSON.parse(rel.triple_tags) : [],
    }));

    return {
      relationships,
      totalBeforeFilter: totalRelationships.count,
    };
  }

  searchActors(query: string): any[] {
    return this.db.prepare(`
      SELECT DISTINCT
        COALESCE(ea.canonical_name, rt.actor) as name,
        COUNT(*) as connection_count
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea ON rt.actor = ea.original_name
      WHERE COALESCE(ea.canonical_name, rt.actor) LIKE ?
      GROUP BY COALESCE(ea.canonical_name, rt.actor)
      ORDER BY connection_count DESC
      LIMIT 20
    `).all(`%${query}%`);
  }

  getActorCount(name: string): number {
    const yearMin = this.config.analysis.yearRangeMin;
    const result = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name
      WHERE (COALESCE(ea_actor.canonical_name, rt.actor) = ? OR COALESCE(ea_target.canonical_name, rt.target) = ?)
      AND (rt.timestamp IS NULL OR rt.timestamp >= '${yearMin}-01-01')
    `).get(name, name) as { count: number };
    return result.count;
  }

  getActorCounts(limit: number): Record<string, number> {
    const yearMin = this.config.analysis.yearRangeMin;
    const allRelationships = this.db.prepare(`
      SELECT
        COALESCE(ea_actor.canonical_name, rt.actor) as actor,
        COALESCE(ea_target.canonical_name, rt.target) as target
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name
      WHERE (rt.timestamp IS NULL OR rt.timestamp >= '${yearMin}-01-01')
    `).all() as Array<{ actor: string; target: string }>;

    const actorCounts = new Map<string, number>();
    allRelationships.forEach(rel => {
      actorCounts.set(rel.actor, (actorCounts.get(rel.actor) || 0) + 1);
      actorCounts.set(rel.target, (actorCounts.get(rel.target) || 0) + 1);
    });

    return Array.from(actorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .reduce((acc, [name, count]) => {
        acc[name] = count;
        return acc;
      }, {} as Record<string, number>);
  }

  getDocument(docId: string): any | null {
    return this.db.prepare(`
      SELECT
        doc_id,
        file_path,
        one_sentence_summary,
        paragraph_summary,
        category,
        date_range_earliest,
        date_range_latest
      FROM documents
      WHERE doc_id = ?
    `).get(docId) || null;
  }

  getDocumentText(docId: string): string | null {
    const doc = this.db.prepare('SELECT full_text FROM documents WHERE doc_id = ?').get(docId) as { full_text: string | null } | undefined;
    return doc?.full_text || null;
  }

  close(): void {
    this.db.close();
  }
}
