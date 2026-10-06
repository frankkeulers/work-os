import { sourceSchedule, type Settings, type SourceId } from '@work-os/shared';
import { SOURCE_PRIORITY, type SourceAdapter } from './types';

// Builds the enabled adapters from settings, in priority order (R2.1). A source with no adapter
// yet is skipped, so turning one on early in settings.json does nothing until it ships.

export type AdapterFactory = (settings: Settings) => SourceAdapter;

export function buildSources(settings: Settings | undefined, factories: Partial<Record<SourceId, AdapterFactory>>): SourceAdapter[] {
  if (!settings) return []; // paused: invalid settings and no good copy
  return SOURCE_PRIORITY.filter((id) => factories[id] && sourceSchedule(settings, id).enabled).map((id) => factories[id]!(settings));
}
