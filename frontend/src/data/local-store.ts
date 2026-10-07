import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 数据结构版本：升版时对旧记录做一次兼容迁移，迁移完打上版本号。
const STORAGE_VERSION = 2
const VERSION_KEY = 'airport-ground-handling:entries:version'

// 模块里最后一个业务字段固定是该模块的「状态字段」（如特种车辆的「车辆状态」、装卸设备的「设备状态」）。
export function statusFieldFor(key: string): string | undefined {
  const meta = MODULE_BY_KEY.get(key)
  return meta?.fields[meta.fields.length - 1]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 迁移旧记录：缺字段的老车按原记录兼容，不覆盖它已有的值；
// 状态字段与规范状态统一为同一个结论，避免详情页与维修台各显示各的。
function migrateRow(key: string, row: Partial<EntryRow>): EntryRow {
  const field = statusFieldFor(key)
  const meta = MODULE_BY_KEY.get(key)
  const fieldStatus = field ? row[field] : undefined

  // 规范状态缺失时，沿用业务字段里原有的状态；业务字段也没有就回落到该模块首个状态。
  let status = row.status
  if (status === undefined || status === null || String(status) === '') {
    status =
      fieldStatus !== undefined && fieldStatus !== null && String(fieldStatus) !== ''
        ? String(fieldStatus)
        : meta?.statuses[0] ?? ''
  }
  status = String(status)

  const migrated: EntryRow = {
    ...(row as EntryRow),
    // pending / abnormal 是后加的标记，老记录没有就给保守默认值，不动其它原始字段。
    pending: typeof row.pending === 'boolean' ? row.pending : true,
    abnormal: typeof row.abnormal === 'boolean' ? row.abnormal : false,
    status,
  }

  // 统一保存与读取顺序：以规范状态为准，同步回业务状态字段。
  if (field) {
    migrated[field] = status
  }
  return migrated
}

function migrateModule(key: string, rows: unknown): EntryRow[] {
  if (!Array.isArray(rows)) {
    return clone(SEED_ROWS[key] ?? [])
  }
  return rows.map((row) => migrateRow(key, row as Partial<EntryRow>))
}

type StoredShape = {
  version: number
  entries: Record<string, unknown>
}

function isVersioned(payload: unknown): payload is StoredShape {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'version' in payload &&
    'entries' in payload &&
    typeof (payload as StoredShape).entries === 'object'
  )
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
    return fallback
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
    return fallback
  }

  // 旧版本是裸的 { 模块: 记录[] }，新版本包了一层 version/entries。
  const stored: Record<string, unknown> = isVersioned(parsed)
    ? (parsed.entries as Record<string, unknown>)
    : (parsed as Record<string, unknown>)

  // 逐模块、逐行合并迁移：缺字段的旧记录保留原值，只补缺失项；
  // 存量模块整表保留（不拿种子覆盖用户改动），新增模块才取种子。
  const migrated: Record<string, EntryRow[]> = {}
  for (const key of MODULE_BY_KEY.keys()) {
    migrated[key] = stored[key] !== undefined ? migrateModule(key, stored[key]) : clone(SEED_ROWS[key] ?? [])
  }

  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: STORAGE_VERSION, entries: migrated }),
  )
  window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
  return migrated
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

// 条件提交：仅当目标记录当前状态仍是 expectedStatus 时才写入。
// 并发提交时只有首个结果生效，后来的提交会读到已变更的状态而失败。
export function commitRows(
  key: string,
  rows: EntryRow[],
  guard?: { id: number; expectedStatus: string },
): boolean {
  if (guard) {
    const current = allRows()[key] ?? []
    const latest = current.find((row) => Number(row.id) === guard.id)
    if (!latest || String(latest.status) !== guard.expectedStatus) {
      return false
    }
  }
  persist({ ...allRows(), [key]: rows })
  return true
}

// 一次提交多个模块，保证主动作与联动台账在同一次写入里落库。
export function commitMany(
  changes: { key: string; rows: EntryRow[] }[],
  guard?: { key: string; id: number; expectedStatus: string },
): boolean {
  const current = allRows()
  if (guard) {
    const latest = (current[guard.key] ?? []).find((row) => Number(row.id) === guard.id)
    if (!latest || String(latest.status) !== guard.expectedStatus) {
      return false
    }
  }
  const next = { ...current }
  for (const change of changes) {
    next[change.key] = change.rows
  }
  persist(next)
  return true
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

function persist(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, entries: next }),
    )
    window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
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
