import { query } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';

const db = new Database('document_analysis.db');

interface Actor {
  name: string;
  count: number;
}

interface CandidateGroup {
  names: string[];
  totalCount: number;
}

interface LLMMergeDecision {
  canonical: string;
  aliases: string[];
  reasoning: string;
}

// Create entity_aliases table if it doesn't exist
function initAliasTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      original_name TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT DEFAULT 'llm_dedupe'
    );

    CREATE INDEX IF NOT EXISTS idx_canonical ON entity_aliases(canonical_name);
  `);
}

// Get all actors excluding unknowns and already-aliased names
function getAllActors(): Actor[] {
  const stmt = db.prepare(`
    SELECT
      actor as name,
      COUNT(*) as count
    FROM rdf_triples
    WHERE actor NOT LIKE 'unknown%'
      AND actor NOT LIKE 'redacted%'
      AND actor NOT LIKE 'Unknown%'
      AND actor NOT LIKE 'Redacted%'
      AND actor NOT IN (SELECT original_name FROM entity_aliases)
    GROUP BY actor

    UNION

    SELECT
      target as name,
      COUNT(*) as count
    FROM rdf_triples
    WHERE target NOT LIKE 'unknown%'
      AND target NOT LIKE 'redacted%'
      AND target NOT LIKE 'Unknown%'
      AND target NOT LIKE 'Redacted%'
      AND target NOT IN (SELECT original_name FROM entity_aliases)
    GROUP BY target
  `);

  const results = stmt.all() as Actor[];

  // Aggregate counts
  const actorMap = new Map<string, number>();
  for (const actor of results) {
    const current = actorMap.get(actor.name) || 0;
    actorMap.set(actor.name, current + actor.count);
  }

  return Array.from(actorMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// Generate candidate groups using liberal matching
function generateCandidateGroups(actors: Actor[]): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < actors.length; i++) {
    if (processed.has(actors[i].name)) continue;

    const name1 = actors[i].name.toLowerCase();
    const group: string[] = [actors[i].name];
    let totalCount = actors[i].count;
    processed.add(actors[i].name);

    // Look for similar names (very liberal matching)
    for (let j = i + 1; j < actors.length; j++) {
      if (processed.has(actors[j].name)) continue;

      const name2 = actors[j].name.toLowerCase();

      // Share at least 2 words, or one name contains the other
      const words1 = name1.split(/\s+/);
      const words2 = name2.split(/\s+/);
      const sharedWords = words1.filter(w => words2.includes(w) && w.length > 2);

      if (sharedWords.length >= 2 || name1.includes(name2) || name2.includes(name1)) {
        group.push(actors[j].name);
        totalCount += actors[j].count;
        processed.add(actors[j].name);
      }
    }

    // Only include groups with potential duplicates
    if (group.length > 1) {
      groups.push({ names: group, totalCount });
    }
  }

  return groups.sort((a, b) => b.totalCount - a.totalCount);
}

// Ask LLM to analyze a candidate group
async function analyzeCandidateGroup(group: CandidateGroup): Promise<LLMMergeDecision[]> {
  const prompt = `Analyze these entity names and determine which should be merged (same person) vs kept separate (different people).

RULES:
- DO merge: name variations, nicknames, case differences (John Smith = J. Smith = john smith)
- DO NOT merge: numbered entities (Jane Doe 1 ≠ Jane Doe 2), family members (George H.W. Bush ≠ George W. Bush), generic vs specific (John ≠ John Smith)

Names (${group.names.length} total):
${group.names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Return ONLY valid JSON with this exact structure:
{
  "merge_groups": [
    {"canonical": "Best Full Name", "aliases": ["variant1", "variant2"], "reasoning": "why same person"}
  ],
  "do_not_merge": ["name1"],
  "reasoning_for_no_merge": "why separate"
}

If no merges needed, use empty array: {"merge_groups": [], "do_not_merge": ${JSON.stringify(group.names)}, "reasoning_for_no_merge": "all distinct"}`;

  let responseText = '';

  const agent = query({
    prompt,
    options: {
      model: 'claude-haiku-4-5',
      maxTokens: 4096,
      maxTurns: 3,
      allowedTools: [],
    }
  });

  try {
    for await (const message of agent) {
      if (message.type === 'assistant') {
        const textBlocks = message.message.content.filter((c: any) => c.type === 'text');
        for (const block of textBlocks) {
          responseText += block.text;
        }
      }
    }

    if (!responseText) {
      console.error('No response text for group:', group.names.slice(0, 3));
      return [];
    }

    // Try to extract JSON from markdown code blocks or raw text
    let jsonText = responseText;
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1];
    } else {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }
    }

    if (!jsonText || jsonText.trim() === '') {
      console.error('Could not extract JSON from response for group:', group.names.slice(0, 3));
      console.error('Response preview:', responseText.slice(0, 200));
      return [];
    }

    const parsed = JSON.parse(jsonText.trim());
    return parsed.merge_groups || [];
  } catch (error) {
    console.error('Error analyzing group:', group.names.slice(0, 3), error);
    return [];
  }
}

// Create alias links (non-destructive)
function createAliases(decision: LLMMergeDecision): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO entity_aliases (original_name, canonical_name, reasoning)
    VALUES (?, ?, ?)
  `);

  let count = 0;
  for (const alias of decision.aliases) {
    stmt.run(alias, decision.canonical, decision.reasoning);
    count++;
  }

  return count;
}

async function main() {
  console.log('=== LLM-Based Entity Deduplication (Non-Destructive) ===\n');

  // Initialize alias table
  initAliasTable();
  console.log('✓ Entity alias table ready\n');

  console.log('Loading actors from database...');
  const allActors = getAllActors();
  console.log(`Found ${allActors.length} unique actors (excluding unknown/redacted)`);

  // Filter to only actors with >= 5 occurrences
  const MIN_OCCURRENCES = 5;
  const actors = allActors.filter(a => a.count >= MIN_OCCURRENCES);
  console.log(`Filtered to ${actors.length} actors with >= ${MIN_OCCURRENCES} occurrences (skipped ${allActors.length - actors.length} low-frequency names)\n`);

  console.log('Generating candidate groups...');
  const candidateGroups = generateCandidateGroups(actors);
  console.log(`Generated ${candidateGroups.length} candidate groups\n`);

  if (candidateGroups.length === 0) {
    console.log('No candidate groups found!');
    db.close();
    return;
  }

  console.log('Analyzing groups with LLM (processing 10 in parallel)...\n');

  const BATCH_SIZE = 10;
  let totalAliasesCreated = 0;
  let groupsProcessed = 0;

  for (let i = 0; i < candidateGroups.length; i += BATCH_SIZE) {
    const batch = candidateGroups.slice(i, i + BATCH_SIZE);

    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(candidateGroups.length / BATCH_SIZE)}...`);

    const batchPromises = batch.map(group => analyzeCandidateGroup(group));
    const batchResults = await Promise.all(batchPromises);

    // Add small delay between batches to prevent overwhelming API
    await new Promise(resolve => setTimeout(resolve, 100));

    // Show results for this batch
    for (let j = 0; j < batchResults.length; j++) {
      const decisions = batchResults[j];
      const group = batch[j];

      if (decisions.length > 0) {
        console.log(`\nGroup ${i + j + 1}: ${group.names.slice(0, 3).join(', ')}${group.names.length > 3 ? '...' : ''}`);

        for (const decision of decisions) {
          console.log(`  ✓ Merge: "${decision.canonical}" ← [${decision.aliases.join(', ')}]`);
          console.log(`    Reason: ${decision.reasoning}`);

          // Create aliases (non-destructive)
          const aliasCount = createAliases(decision);
          totalAliasesCreated += aliasCount;
        }
      }

      groupsProcessed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✓ Complete!`);
  console.log(`  Groups analyzed: ${groupsProcessed}`);
  console.log(`  Aliases created: ${totalAliasesCreated}`);
  console.log(`  Original data: PRESERVED (no destructive edits)`);
  console.log(`${'='.repeat(60)}\n`);

  console.log('To query with aliases resolved, use:');
  console.log('  SELECT COALESCE(ea.canonical_name, rt.actor) as resolved_actor');
  console.log('  FROM rdf_triples rt');
  console.log('  LEFT JOIN entity_aliases ea ON rt.actor = ea.original_name');

  db.close();
}

main().catch(console.error);
