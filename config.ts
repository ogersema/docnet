import fs from 'fs';
import path from 'path';

export interface DocNetConfig {
  project: {
    name: string;
    description: string;
    repoUrl: string | null;
    accentColor: string;
  };
  principal: {
    name: string | null;
    aliases: string[];
    hopFilterDefault: number | null;
    hopFilterEnabled: boolean;
  };
  analysis: {
    model: string;
    documentCategories: string[];
    yearRangeMin: number;
    yearRangeMax: number;
    includeUndatedDefault: boolean;
  };
  ui: {
    welcomeTitle: string;
    welcomeBody: string;
    howToUse: string[];
    searchPlaceholder: string;
    defaultRelationshipLimit: number;
    mobileRelationshipLimit: number;
    aiAttributionNote: string;
  };
  export: {
    enabled: boolean;
    outputPath: string;
    includeFullText: boolean;
  };
  server: {
    port: number;
    dbPath: string;
    allowedOrigins: string[];
  };
}

function loadConfig(): DocNetConfig {
  const configPath = path.join(process.cwd(), 'docnet.config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ docnet.config.json not found. Copy docnet.config.example.json to get started.');
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as DocNetConfig;
  } catch (e) {
    console.error('❌ Failed to parse docnet.config.json:', e);
    process.exit(1);
  }
}

export const config = loadConfig();
