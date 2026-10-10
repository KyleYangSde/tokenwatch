export type Source = 'claude' | 'codex';
export interface UsageEvent {
  source: Source; session: string; project: string; model: string; timestamp: string;
  input: number; output: number; cacheWrite: number; cacheRead: number; reasoning: number;
  total: number;
}
export const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
export const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const string = (v: unknown, fallback: string): string => typeof v === 'string' && v.length > 0 ? v : fallback;
