/**
 * KADE Oct 16 2026 — puppet bodies for characters (/api/kade/agent-body).
 * The server compiles a body recipe into a scene (schema `kade-puppet-scene/1`); clients
 * only draw scenes, so the scene is passed through untyped here.
 */

/** A body recipe as the kit normalizes it; editors change fields by catalog `path`. */
export type TAgentBodyRecipe = Record<string, unknown> & {
  schema?: number;
  accessories?: string[];
};

export type TAgentBodySource = 'editor' | 'words' | 'picture' | 'surprise' | 'auto';

export interface TAgentBody {
  agentId: string | null;
  rev: number;
  source: TAgentBodySource | null;
  updatedAt: string | null;
  recipe: TAgentBodyRecipe | null;
  description: string | null;
  sceneHash: string | null;
  /** The compiled scene (absent when requested with `?scene=0`). */
  scene?: Record<string, unknown> | null;
  /** Paid helpers only: what the design cost, in the person's own price. */
  costUSD?: number;
}

export type TAgentBodyOption = {
  id: string;
  name: string;
  note?: string;
  hex?: string | null;
  fantasy?: boolean;
};

export type TAgentBodyControl =
  | { path: string; kind: 'choice'; name: string; options: TAgentBodyOption[] }
  | { path: string; kind: 'color'; name: string; options: TAgentBodyOption[] }
  | { path: string; kind: 'slider'; name: string; ends: [string, string] }
  | {
      path: 'accessories';
      kind: 'accessory';
      slot: string;
      name: string;
      options: TAgentBodyOption[];
    };

export interface TAgentBodyCatalog {
  schema: number;
  kit: string;
  catalog: {
    schema: number;
    sections: { id: string; name: string; controls: TAgentBodyControl[] }[];
  };
  defaults: TAgentBodyRecipe;
}

export interface TSaveAgentBodyRequest {
  agentId: string;
  recipe: TAgentBodyRecipe;
  baseRev: number;
  source?: TAgentBodySource;
}

/** 409 body: someone saved first; `latest` is their version. */
export interface TAgentBodyConflict {
  error: string;
  latest: TAgentBody;
}
