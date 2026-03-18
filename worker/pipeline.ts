import Anthropic from '@anthropic-ai/sdk';
import { PostgresAdapter } from '../storage/PostgresAdapter.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

const client = new Anthropic();

function buildPrincipalContext(): string {
  const p = config.principal;
  if (!p.name) return '';
  const aliasBullets = p.aliases.map(a => `- ${a}`).join('\n');
  return `
**PRINCIPAL ENTITY IDENTIFICATION:**
This document collection centers on: ${p.name}

This entity may appear under these alternative identifiers:
${aliasBullets || '(no aliases configured)'}

When you see ANY of these identifiers as a sender, participant, or actor, you MUST use "${p.name}" as the canonical actor name in your RDF triples.
`.trim();
}

function buildActorExamples(): string {
  if (config.principal.name) {
    return `- Good: actor: "${config.principal.name}" (when you see their aliases)
  - Good: actor: "Full Name of Person"
  - Bad: Using an alias instead of the canonical name`;
  }
  return `- Good: actor: "Full Name of Person"
  - Bad: actor: "FBI" (organization), actor: "the investigation" (abstract)`;
}

function buildPrompt(content: string, docId: string): string {
  const principalSection = buildPrincipalContext();
  const principalBlock = principalSection ? `\n${principalSection}\n` : '';

  return `You are analyzing a document from a document collection. The document ID is "${docId}".

IMPORTANT: You have ALL the information you need in the document text below. Do NOT attempt to read files, explore directories, or gather additional context. Analyze ONLY the text provided.

${principalBlock}
Here is the document text:
\`\`\`
${content}
\`\`\`

Your task is to analyze this document and extract structured information. Focus on:

1. **Main actors/participants** - People, organizations, entities mentioned or involved
2. **Key events and actions** - What happened, when, between whom
3. **Temporal information** - Dates, times, sequences of events
4. **Document type and content** - What kind of document is this?
5. **Key themes and topics** - What is this document about?

Return ONLY a valid JSON object with the following structure:

\`\`\`json
{
  "one_sentence_summary": "A brief one-sentence summary including main actors",
  "paragraph_summary": "A detailed paragraph (3-5 sentences) explaining the document's content, context, significance, and key points.",
  "date_range_earliest": "YYYY-MM-DD or YYYY-MM-DDTHH:MM format if dates are visible, otherwise null",
  "date_range_latest": "YYYY-MM-DD or YYYY-MM-DDTHH:MM format if dates are visible, otherwise null",
  "category": "One of: ${config.analysis.documentCategories.join(', ')}",
  "content_tags": ["array", "of", "relevant", "tags"],
  "rdf_triples": [
    {
      "timestamp": "YYYY-MM-DD or YYYY-MM-DDTHH:MM if available, otherwise omit",
      "actor": "PERSON NAME ONLY - always use the full canonical name",
      "action": "descriptive verb phrase",
      "target": "PERSON NAME, organization, or entity",
      "location": "physical location if mentioned, otherwise omit",
      "actor_likely_type": "OPTIONAL - only if actor is unknown/unnamed",
      "tags": ["tags", "for", "this", "triple"],
      "explicit_topic": "short phrase describing what the interaction directly says",
      "implicit_topic": "short phrase describing what it likely implies"
    }
  ]
}
\`\`\`

Guidelines for RDF triples:
- Create a sequential array capturing the key relationships and events
- Include timestamps when dates/times are mentioned
- **Actor field**: Actor must ALWAYS be a PERSON NAME ONLY
  ${buildActorExamples()}
- **Target field**: Target can be a person, place, organization, or entity
- Use consistent naming (always use the full canonical name of a person)
- Actions should be descriptive verb phrases
- Focus on person-to-person AND person-to-entity relationships
- Order triples chronologically when timestamps are available
- Extract sufficient triples to accurately capture relationships

If the document is too fragmentary or unreadable, still provide your best interpretation and mark uncertainty in the summaries.`;
}

function calculateCost(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }): number {
  // Claude Sonnet 4 pricing (adjust as needed)
  const inputCost = (usage.input_tokens / 1_000_000) * 3;
  const outputCost = (usage.output_tokens / 1_000_000) * 15;
  const cacheCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * 0.3;
  return inputCost + outputCost + cacheCost;
}

export async function analyzeText(params: {
  projectId: string;
  docId: string;
  filePath: string;
  content: string;
  originalName: string;
}): Promise<{ triplesCount: number; cost: number }> {
  const adapter = new PostgresAdapter(pool, params.projectId);

  // Check if already analyzed
  const existing = await adapter.getDocument(params.docId);
  if (existing) return { triplesCount: 0, cost: 0 };

  const prompt = buildPrompt(params.content, params.docId);

  const message = await client.messages.create({
    model: config.analysis.model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }]
  });

  // Extract text content
  const textContent = message.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map(c => c.text)
    .join('');

  // Parse JSON from response
  const jsonMatch = textContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = jsonMatch ? jsonMatch[1] : textContent;

  let analysis: any;
  try {
    analysis = JSON.parse(jsonText.trim());
  } catch {
    // Try to find any JSON object in the response
    const objMatch = textContent.match(/\{[\s\S]*\}/);
    if (objMatch) {
      analysis = JSON.parse(objMatch[0]);
    } else {
      throw new Error('Failed to parse analysis response as JSON');
    }
  }

  // Save document and triples
  await adapter.saveDocument({
    docId: params.docId,
    filePath: params.filePath,
    fullText: params.content,
    analysis,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });

  await adapter.saveTriples(params.docId, analysis.rdf_triples || []);

  const cost = calculateCost(message.usage);
  return { triplesCount: (analysis.rdf_triples || []).length, cost };
}
