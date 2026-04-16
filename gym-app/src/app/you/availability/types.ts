/**
 * Shared types for /you/availability. Kept separate so both the server
 * page and the client component can import without dragging a 'use
 * client' boundary through.
 */

import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';

export type WindowRow = {
  id: string;
  starts_on: string;
  ends_on: string;
  kind: AvailabilityWindowKind;
  strategy: AvailabilityWindowStrategy;
  note: string | null;
  metadata: Record<string, unknown> | null;
  status: 'active' | 'cancelled';
  created_at: string;
  cancelled_at: string | null;
};

/** Shape of the AvailabilityDiffOk as it flows to / from the client. */
export type DiffCreate = {
  date: string;
  type: string;
  day_code: string | null;
  source: string;
};

export type DiffUpdate = {
  plan_id: string;
  date: string;
  before: { type: string; day_code: string | null; source: string; window_id: string | null };
  after: { type: string; day_code: string | null; source: string };
};

export type DiffDelete = {
  plan_id: string;
  date: string;
  before: { type: string; day_code: string | null; source: string; window_id: string | null };
};

export type DiffSummary = {
  added: number;
  removed: number;
  changed: number;
  skipped_logged: number;
  skipped_manual: number;
  skipped_ai_proposed: number;
  skipped_other_window: number;
};

export type AvailabilityDiffOk = {
  kind: 'ok';
  intent: 'create' | 'cancel' | 'modify';
  window_id: string;
  range: { start: string; end: string } | null;
  creates: DiffCreate[];
  updates: DiffUpdate[];
  deletes: DiffDelete[];
  summary: DiffSummary;
  rationale: string;
};

export type Conflict = {
  id: string;
  starts_on: string;
  ends_on: string;
  kind: AvailabilityWindowKind;
};
