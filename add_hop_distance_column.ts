import Database from 'better-sqlite3';
import { config } from './config';

const db = new Database('document_analysis.db');

interface ActorNode {
  name: string;
  hopDistance: number | null;
}

interface Edge {
  actor: string;
  target: string;
}

console.log('📊 Adding hop_distance_from_principal column and calculating distances...\n');

// Step 1: Add the column
console.log('Adding hop_distance_from_principal column to entity_aliases...');
db.exec(`
  ALTER TABLE entity_aliases ADD COLUMN hop_distance_from_principal INTEGER;
`);

// Create an index for performance
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_hop_distance ON entity_aliases(hop_distance_from_principal);
`);

console.log('✓ Column added\n');

// Step 2: Get all relationships from the database (with alias resolution)
console.log('Loading relationships from database...');
const relationshipsQuery = db.prepare(`
  SELECT DISTINCT
    COALESCE(ea1.canonical_name, rt.actor) as actor,
    COALESCE(ea2.canonical_name, rt.target) as target
  FROM rdf_triples rt
  LEFT JOIN entity_aliases ea1 ON rt.actor = ea1.original_name
  LEFT JOIN entity_aliases ea2 ON rt.target = ea2.original_name
  WHERE rt.actor NOT LIKE 'unknown%'
    AND rt.actor NOT LIKE 'redacted%'
    AND rt.target NOT LIKE 'unknown%'
    AND rt.target NOT LIKE 'redacted%'
`);

const edges: Edge[] = relationshipsQuery.all() as Edge[];
console.log(`✓ Loaded ${edges.length} unique relationships\n`);

// Step 3: Build adjacency list
console.log('Building graph adjacency list...');
const adjacencyList = new Map<string, Set<string>>();

for (const edge of edges) {
  // Bidirectional edges (undirected graph)
  if (!adjacencyList.has(edge.actor)) {
    adjacencyList.set(edge.actor, new Set());
  }
  adjacencyList.get(edge.actor)!.add(edge.target);

  if (!adjacencyList.has(edge.target)) {
    adjacencyList.set(edge.target, new Set());
  }
  adjacencyList.get(edge.target)!.add(edge.actor);
}

console.log(`✓ Built graph with ${adjacencyList.size} unique actors\n`);

// Step 4: BFS from principal to calculate hop distances
const PRINCIPAL = config.principal.name || '';
console.log(`Calculating hop distances from ${PRINCIPAL} using BFS...`);

const hopDistances = new Map<string, number>();
const queue: { name: string; distance: number }[] = [{ name: PRINCIPAL, distance: 0 }];
const visited = new Set<string>();

visited.add(PRINCIPAL);
hopDistances.set(PRINCIPAL, 0);

while (queue.length > 0) {
  const current = queue.shift()!;
  const neighbors = adjacencyList.get(current.name);

  if (neighbors) {
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        const newDistance = current.distance + 1;
        hopDistances.set(neighbor, newDistance);
        queue.push({ name: neighbor, distance: newDistance });
      }
    }
  }
}

console.log(`✓ Calculated distances for ${hopDistances.size} actors\n`);

// Step 5: Insert all canonical actors into entity_aliases if they don't exist
console.log('Ensuring all canonical actors exist in entity_aliases...');

const insertAlias = db.prepare(`
  INSERT OR IGNORE INTO entity_aliases (original_name, canonical_name, reasoning, created_by)
  VALUES (?, ?, ?, ?)
`);

const insertAliasTransaction = db.transaction((actors: string[]) => {
  for (const actor of actors) {
    insertAlias.run(
      actor,
      actor,
      'Self-reference for canonical actor (created for hop distance calculation)',
      'hop_distance_migration'
    );
  }
});

const allCanonicalActors = Array.from(adjacencyList.keys());
insertAliasTransaction(allCanonicalActors);

console.log(`✓ Ensured ${allCanonicalActors.length} canonical actors exist in entity_aliases\n`);

// Step 6: Update hop distances in entity_aliases table
console.log('Updating hop distances in entity_aliases...');

const updateStmt = db.prepare(`
  UPDATE entity_aliases
  SET hop_distance_from_principal = ?
  WHERE canonical_name = ?
`);

const updateTransaction = db.transaction((distances: Map<string, number>) => {
  let updated = 0;
  for (const [actor, distance] of distances.entries()) {
    const result = updateStmt.run(distance, actor);
    if (result.changes > 0) {
      updated++;
    }
  }
  return updated;
});

const updatedCount = updateTransaction(hopDistances);

console.log(`✓ Updated ${updatedCount} actors with hop distances\n`);

// Step 7: Show distribution of hop distances
console.log('Hop distance distribution:');
const distributionQuery = db.prepare(`
  SELECT hop_distance_from_principal, COUNT(*) as count
  FROM entity_aliases
  GROUP BY hop_distance_from_principal
  ORDER BY hop_distance_from_principal
`);

const distribution = distributionQuery.all() as { hop_distance_from_principal: number | null; count: number }[];

for (const row of distribution) {
  const label = row.hop_distance_from_principal === null ? 'NULL (disconnected)' : `${row.hop_distance_from_principal} hops`;
  console.log(`  ${label}: ${row.count} actors`);
}

console.log('\n✅ Migration complete!\n');

db.close();
