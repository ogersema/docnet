import { Pool } from 'pg';
import type {
  IStorageAdapter,
  RelationshipParams,
  RelationshipResult,
  ActorRelationshipResult,
} from './IStorageAdapter.js';

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

export class PostgresAdapter implements IStorageAdapter {
  private pool: Pool;
  private projectId: string;

  constructor(pool: Pool, projectId: string) {
    this.pool = pool;
    this.projectId = projectId;
  }

  async getStats(): Promise<any> {
    const [docs, triples, actors, categories] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as count FROM documents WHERE project_id = $1', [this.projectId]),
      this.pool.query('SELECT COUNT(*) as count FROM rdf_triples WHERE project_id = $1', [this.projectId]),
      this.pool.query(`
        SELECT COUNT(DISTINCT COALESCE(ea.canonical_name, rt.actor)) as count
        FROM rdf_triples rt
        LEFT JOIN entity_aliases ea ON rt.actor = ea.original_name AND ea.project_id = $1
        WHERE rt.project_id = $1
      `, [this.projectId]),
      this.pool.query(`
        SELECT category, COUNT(*) as count
        FROM documents
        WHERE project_id = $1
        GROUP BY category
        ORDER BY count DESC
      `, [this.projectId]),
    ]);

    return {
      totalDocuments: { count: parseInt(docs.rows[0].count) },
      totalTriples: { count: parseInt(triples.rows[0].count) },
      totalActors: { count: parseInt(actors.rows[0].count) },
      categories: categories.rows.map(r => ({ category: r.category, count: parseInt(r.count) })),
    };
  }

  async getTagClusters(): Promise<any[]> {
    const { rows } = await this.pool.query(
      'SELECT cluster_data FROM tag_clusters WHERE project_id = $1',
      [this.projectId]
    );
    if (rows.length === 0) return [];
    const clusters = rows[0].cluster_data;
    if (!Array.isArray(clusters)) return [];
    return clusters.map((cluster: any) => ({
      id: cluster.id,
      name: cluster.name,
      exemplars: cluster.exemplars,
      tagCount: cluster.tags?.length || 0,
    }));
  }

  async getRelationships(params: RelationshipParams): Promise<RelationshipResult> {
    const { limit, clusterIds, categories, yearRange, includeUndated, keywords, maxHops } = params;
    const selectedClusterIds = new Set<number>(clusterIds);

    const queryParams: any[] = [this.projectId];
    let paramIdx = 2;

    let categoryWhere = '';
    if (categories.length > 0) {
      const placeholders = categories.map(() => `$${paramIdx++}`).join(',');
      categoryWhere = `AND d.category IN (${placeholders})`;
      queryParams.push(...categories);
    }

    let yearWhere = '';
    if (yearRange) {
      const [minYear, maxYear] = yearRange;
      if (includeUndated) {
        yearWhere = `AND (rt.timestamp IS NULL OR (CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= $${paramIdx} AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= $${paramIdx + 1}))`;
      } else {
        yearWhere = `AND (rt.timestamp IS NOT NULL AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= $${paramIdx} AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= $${paramIdx + 1})`;
      }
      queryParams.push(minYear, maxYear);
      paramIdx += 2;
    }

    let hopJoins = '';
    let hopWhere = '';
    if (maxHops !== null && maxHops !== undefined) {
      hopJoins = `
      LEFT JOIN canonical_entities ce_actor ON COALESCE(ea_actor.canonical_name, rt.actor) = ce_actor.canonical_name AND ce_actor.project_id = $1
      LEFT JOIN canonical_entities ce_target ON COALESCE(ea_target.canonical_name, rt.target) = ce_target.canonical_name AND ce_target.project_id = $1`;
      hopWhere = `AND ce_actor.hop_distance_from_principal <= $${paramIdx}
                  AND ce_target.hop_distance_from_principal <= $${paramIdx + 1}`;
      queryParams.push(maxHops, maxHops);
      paramIdx += 2;
    }

    const MAX_DB_LIMIT = 100000;
    queryParams.push(MAX_DB_LIMIT);

    const sql = `
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
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name AND ea_actor.project_id = $1
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name AND ea_target.project_id = $1
      ${hopJoins}
      LEFT JOIN documents d ON rt.doc_id = d.doc_id AND d.project_id = $1
      WHERE rt.project_id = $1
      ${categoryWhere}
      ${yearWhere}
      ${hopWhere}
      ORDER BY rt.timestamp
      LIMIT $${paramIdx}
    `;

    const { rows: allRelationships } = await this.pool.query(sql, queryParams);

    // Filter by tag clusters
    let filteredRelationships = allRelationships.filter((rel: any) => {
      if (selectedClusterIds.size === 0) return true;
      try {
        const topClusters = rel.top_cluster_ids || [];
        return topClusters.some((clusterId: number) => selectedClusterIds.has(clusterId));
      } catch {
        return false;
      }
    });

    // Filter by keywords
    if (keywords.length > 0) {
      filteredRelationships = filteredRelationships.filter((rel: any) => {
        const searchText = `${rel.actor} ${rel.action} ${rel.target} ${rel.location || ''}`;
        return calculateBM25Score(searchText, keywords) > 0;
      });
    }

    // Deduplicate edges
    const edgeMap = new Map<string, any[]>();
    filteredRelationships.forEach((rel: any) => {
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

    const relationships = prunedRelationships.map(({ triple_tags, top_cluster_ids, ...rel }: any) => ({
      ...rel,
      tags: triple_tags || [],
    }));

    return {
      relationships,
      totalBeforeLimit: uniqueEdges.length,
      totalBeforeFilter: allRelationships.length,
    };
  }

  async getActorRelationships(name: string, params: RelationshipParams): Promise<ActorRelationshipResult> {
    const { clusterIds, categories, yearRange, includeUndated, keywords, maxHops } = params;
    const selectedClusterIds = new Set<number>(clusterIds);

    // Find all aliases for this name
    const aliasResult = await this.pool.query(`
      SELECT original_name as name FROM entity_aliases WHERE canonical_name = $1 AND project_id = $2
      UNION
      SELECT canonical_name as name FROM entity_aliases WHERE original_name = $1 AND project_id = $2
      UNION
      SELECT $1 as name
    `, [name, this.projectId]);

    const allNames = aliasResult.rows.map((row: any) => row.name);

    // Total count without filters
    let totalParamIdx = 1;
    const totalParams: any[] = [];
    const namePlaceholders = allNames.map(() => `$${totalParamIdx++}`).join(',');
    totalParams.push(...allNames);
    const namePlaceholders2 = allNames.map(() => `$${totalParamIdx++}`).join(',');
    totalParams.push(...allNames);
    totalParams.push(this.projectId);

    const totalResult = await this.pool.query(`
      SELECT COUNT(*) as count
      FROM rdf_triples rt
      WHERE (rt.actor IN (${namePlaceholders}) OR rt.target IN (${namePlaceholders2}))
        AND rt.project_id = $${totalParamIdx}
    `, totalParams);

    // Build main query
    let paramIdx = 1;
    const queryParams: any[] = [];
    const np1 = allNames.map(() => `$${paramIdx++}`).join(',');
    queryParams.push(...allNames);
    const np2 = allNames.map(() => `$${paramIdx++}`).join(',');
    queryParams.push(...allNames);
    const projectParamIdx = paramIdx++;
    queryParams.push(this.projectId);

    let categoryWhere = '';
    if (categories.length > 0) {
      const placeholders = categories.map(() => `$${paramIdx++}`).join(',');
      categoryWhere = `AND d.category IN (${placeholders})`;
      queryParams.push(...categories);
    }

    let yearWhere = '';
    if (yearRange) {
      const [minYear, maxYear] = yearRange;
      if (includeUndated) {
        yearWhere = `AND (rt.timestamp IS NULL OR (CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= $${paramIdx} AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= $${paramIdx + 1}))`;
      } else {
        yearWhere = `AND (rt.timestamp IS NOT NULL AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) >= $${paramIdx} AND CAST(substr(rt.timestamp, 1, 4) AS INTEGER) <= $${paramIdx + 1})`;
      }
      queryParams.push(minYear, maxYear);
      paramIdx += 2;
    }

    let hopJoins = '';
    let hopWhere = '';
    if (maxHops !== null && maxHops !== undefined) {
      hopJoins = `
      LEFT JOIN canonical_entities ce_actor ON COALESCE(ea_actor.canonical_name, rt.actor) = ce_actor.canonical_name AND ce_actor.project_id = $${projectParamIdx}
      LEFT JOIN canonical_entities ce_target ON COALESCE(ea_target.canonical_name, rt.target) = ce_target.canonical_name AND ce_target.project_id = $${projectParamIdx}`;
      hopWhere = `AND ce_actor.hop_distance_from_principal <= $${paramIdx}
                  AND ce_target.hop_distance_from_principal <= $${paramIdx + 1}`;
      queryParams.push(maxHops, maxHops);
      paramIdx += 2;
    }

    const sql = `
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
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name AND ea_actor.project_id = $${projectParamIdx}
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name AND ea_target.project_id = $${projectParamIdx}
      ${hopJoins}
      LEFT JOIN documents d ON rt.doc_id = d.doc_id AND d.project_id = $${projectParamIdx}
      WHERE (rt.actor IN (${np1}) OR rt.target IN (${np2}))
        AND rt.project_id = $${projectParamIdx}
        ${categoryWhere}
        ${yearWhere}
        ${hopWhere}
      ORDER BY rt.timestamp
    `;

    const { rows: allRelationships } = await this.pool.query(sql, queryParams);

    // Filter by tag clusters
    let filteredRelationships = allRelationships.filter((rel: any) => {
      if (selectedClusterIds.size === 0) return true;
      try {
        const topClusters = rel.top_cluster_ids || [];
        return topClusters.some((clusterId: number) => selectedClusterIds.has(clusterId));
      } catch {
        return false;
      }
    });

    // Filter by keywords
    if (keywords.length > 0) {
      filteredRelationships = filteredRelationships.filter((rel: any) => {
        const searchText = `${rel.actor} ${rel.action} ${rel.target} ${rel.location || ''}`;
        return calculateBM25Score(searchText, keywords) > 0;
      });
    }

    const relationships = filteredRelationships.map(({ triple_tags, top_cluster_ids, ...rel }: any) => ({
      ...rel,
      tags: triple_tags || [],
    }));

    return {
      relationships,
      totalBeforeFilter: parseInt(totalResult.rows[0].count),
    };
  }

  async searchActors(query: string): Promise<any[]> {
    const { rows } = await this.pool.query(`
      SELECT DISTINCT
        COALESCE(ea.canonical_name, rt.actor) as name,
        COUNT(*) as connection_count
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea ON rt.actor = ea.original_name AND ea.project_id = $1
      WHERE rt.project_id = $1
        AND COALESCE(ea.canonical_name, rt.actor) ILIKE $2
      GROUP BY COALESCE(ea.canonical_name, rt.actor)
      ORDER BY connection_count DESC
      LIMIT 20
    `, [this.projectId, `%${query}%`]);
    return rows.map(r => ({ ...r, connection_count: parseInt(r.connection_count) }));
  }

  async getActorCount(name: string): Promise<number> {
    const { rows } = await this.pool.query(`
      SELECT COUNT(*) as count
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name AND ea_actor.project_id = $1
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name AND ea_target.project_id = $1
      WHERE rt.project_id = $1
        AND (COALESCE(ea_actor.canonical_name, rt.actor) = $2 OR COALESCE(ea_target.canonical_name, rt.target) = $2)
    `, [this.projectId, name]);
    return parseInt(rows[0].count);
  }

  async getActorCounts(limit: number): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(`
      SELECT
        COALESCE(ea_actor.canonical_name, rt.actor) as actor,
        COALESCE(ea_target.canonical_name, rt.target) as target
      FROM rdf_triples rt
      LEFT JOIN entity_aliases ea_actor ON rt.actor = ea_actor.original_name AND ea_actor.project_id = $1
      LEFT JOIN entity_aliases ea_target ON rt.target = ea_target.original_name AND ea_target.project_id = $1
      WHERE rt.project_id = $1
    `, [this.projectId]);

    const actorCounts = new Map<string, number>();
    rows.forEach((rel: any) => {
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

  async getDocument(docId: string): Promise<any | null> {
    const { rows } = await this.pool.query(`
      SELECT
        doc_id,
        file_path,
        one_sentence_summary,
        paragraph_summary,
        category,
        date_range_earliest,
        date_range_latest
      FROM documents
      WHERE doc_id = $1 AND project_id = $2
    `, [docId, this.projectId]);
    return rows[0] || null;
  }

  async getDocumentText(docId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT full_text FROM documents WHERE doc_id = $1 AND project_id = $2',
      [docId, this.projectId]
    );
    return rows[0]?.full_text || null;
  }

  async saveDocument(doc: {
    docId: string;
    filePath: string;
    fullText?: string;
    analysis: any;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
    error?: string;
  }): Promise<void> {
    const a = doc.analysis;
    await this.pool.query(`
      INSERT INTO documents (
        project_id, doc_id, file_path, one_sentence_summary, paragraph_summary,
        date_range_earliest, date_range_latest, category, content_tags, full_text,
        analysis_timestamp, input_tokens, output_tokens, cache_read_tokens,
        cost_usd, error
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (project_id, doc_id) DO UPDATE SET
        one_sentence_summary = EXCLUDED.one_sentence_summary,
        paragraph_summary = EXCLUDED.paragraph_summary,
        category = EXCLUDED.category,
        content_tags = EXCLUDED.content_tags,
        full_text = EXCLUDED.full_text,
        analysis_timestamp = EXCLUDED.analysis_timestamp
    `, [
      this.projectId,
      doc.docId,
      doc.filePath,
      a.one_sentence_summary || '',
      a.paragraph_summary || '',
      a.date_range_earliest || null,
      a.date_range_latest || null,
      a.category || 'other',
      JSON.stringify(a.content_tags || []),
      doc.fullText || null,
      new Date().toISOString(),
      doc.inputTokens || null,
      doc.outputTokens || null,
      doc.cacheReadTokens || null,
      doc.costUsd || null,
      doc.error || null,
    ]);
  }

  async saveTriples(docId: string, triples: any[]): Promise<void> {
    if (!triples || triples.length === 0) return;
    for (let i = 0; i < triples.length; i++) {
      const t = triples[i];
      if (!t.actor || !t.action || !t.target) continue;
      await this.pool.query(`
        INSERT INTO rdf_triples (
          project_id, doc_id, timestamp, actor, action, target, location,
          actor_likely_type, triple_tags, explicit_topic, implicit_topic, sequence_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        this.projectId,
        docId,
        t.timestamp || null,
        t.actor,
        t.action,
        t.target,
        t.location || null,
        t.actor_likely_type || null,
        JSON.stringify(t.tags || []),
        t.explicit_topic || null,
        t.implicit_topic || null,
        i,
      ]);
    }
  }

  async saveAliases(aliases: Array<{ originalName: string; canonicalName: string; reasoning?: string }>): Promise<void> {
    for (const a of aliases) {
      await this.pool.query(`
        INSERT INTO entity_aliases (project_id, original_name, canonical_name, reasoning)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (project_id, original_name) DO UPDATE SET
          canonical_name = EXCLUDED.canonical_name,
          reasoning = EXCLUDED.reasoning
      `, [this.projectId, a.originalName, a.canonicalName, a.reasoning || null]);
    }
  }

  close(): void {
    // Pool is shared; don't close it per-adapter
  }
}
