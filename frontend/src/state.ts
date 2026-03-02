import type { SortKey } from './lib/query';

export const PAGE_SIZE = 24;

// ── UI / filter state ──────────────────────────────────────────────────────

export let currentPage: number = 1;
export let totalClips: number = 0;
export let searchQuery: string = '';
export let sortBy: SortKey = 'view_count_desc';
export let gameFilter: string = '';
export let currentView: 'grid' | 'calendar' = 'grid';

// ── Calendar navigation state ─────────────────────────────────────────────

export let calYear: number = new Date().getFullYear();
export let calMonth: number | null = null;
export let calDay: string | null = null;
export let calWeek: string | null = null;
export let calDateFrom: string | null = null;
export let calDateTo: string | null = null;
export let calMinDate: string | null = null;
export let calMaxDate: string | null = null;

// ── DB capability flags ────────────────────────────────────────────────────

export let useFts: boolean = false;

// ── Setters ───────────────────────────────────────────────────────────────
// ES module live bindings are read-only from importing modules, so mutations
// must go through these setters.

export function setCurrentPage(v: number): void { currentPage = v; }
export function setTotalClips(v: number): void { totalClips = v; }
export function setSearchQuery(v: string): void { searchQuery = v; }
export function setSortBy(v: SortKey): void { sortBy = v; }
export function setGameFilter(v: string): void { gameFilter = v; }
export function setCurrentView(v: 'grid' | 'calendar'): void { currentView = v; }
export function setCalYear(v: number): void { calYear = v; }
export function setCalMonth(v: number | null): void { calMonth = v; }
export function setCalDay(v: string | null): void { calDay = v; }
export function setCalWeek(v: string | null): void { calWeek = v; }
export function setCalDateFrom(v: string | null): void { calDateFrom = v; }
export function setCalDateTo(v: string | null): void { calDateTo = v; }
export function setCalMinDate(v: string | null): void { calMinDate = v; }
export function setCalMaxDate(v: string | null): void { calMaxDate = v; }
export function setUseFts(v: boolean): void { useFts = v; }
