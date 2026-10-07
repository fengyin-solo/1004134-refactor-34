import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 读取顺序统一：以原记录为主，只补它缺的字段；权威 status 与业务状态字段始终对齐，
// 这样列表动态列与「当前状态」列读到的是同一份结论。
function reconcileRow(key: string, row: Partial<EntryRow>, seed: EntryRow | undefined): EntryRow {
  const merged: EntryRow = { ...(seed ?? {}), ...(row as EntryRow) }
  const meta = MODULE_BY_KEY.get(key)
  if (meta) {
    const statusField = meta.fields[meta.fields.length - 1]
    const status = merged.status ?? seed?.status ?? meta.statuses[0]
    merged.status = status
    // 业务状态字段缺失，或还停留在迁移前种子值而权威状态已流转时，统一采用权威 status 的结论。
    if (
      merged[statusField] === undefined ||
      (merged[statusField] === seed?.[statusField] && status !== seed?.status)
    ) {
      merged[statusField] = status
    }
    if (merged.pending === undefined) {
      merged.pending = seed?.pending ?? status !== meta.statuses[meta.statuses.length - 1]
    }
    if (merged.abnormal === undefined) {
      merged.abnormal = seed?.abnormal ?? false
    }
  }
  return merged
}

function reconcileModule(key: string, stored: EntryRow[] | undefined, fallback: EntryRow[]): EntryRow[] {
  if (!stored) {
    return clone(fallback)
  }
  const seedsById = new Map(fallback.map((row) => [Number(row.id), row]))
  // 迁移时缺字段的旧车按原记录兼容：保留它已有的值，仅补齐结构上缺失的字段。
  return stored.map((row) => reconcileRow(key, row, seedsById.get(Number(row.id))))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged: Record<string, EntryRow[]> = {}
    for (const key of Object.keys(fallback)) {
      merged[key] = reconcileModule(key, parsed[key], fallback[key])
    }
    // 兼容本地存在、但当前种子里已没有的模块数据，不做丢弃。
    for (const key of Object.keys(parsed)) {
      if (!(key in merged)) {
        merged[key] = reconcileModule(key, parsed[key], [])
      }
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
