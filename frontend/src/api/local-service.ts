import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitMany,
  listRows,
  resetRows,
  statusFieldFor,
} from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 特种车辆的另一个入口：替代设备台账。车辆状态结论要同步给同编号的装卸设备。
const REPLACEMENT_LEDGER: Record<string, string> = {
  special_vehicle: 'load_equip',
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 保存顺序：规范状态先落定，再镜像到业务状态字段，保证详情页与维修台读到同一个结论。
function withStatus(row: EntryRow, meta: ModuleMeta, target: string, abnormal: boolean): EntryRow {
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal,
  }
  const statusField = meta.fields[meta.fields.length - 1]
  if (statusField) {
    updated[statusField] = target
  }
  return updated
}

// 特种车辆的可用结论同步到替代设备台账：待命=可执行任务，其余结论一一对应。
function replacementStatusFor(target: string): string {
  const mapping: Record<string, string> = {
    待命: '待机',
    出车中: '运行中',
    维保中: '维保中',
    已停用: '已报修',
  }
  return mapping[target] ?? target
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const expectedStatus = String(rows[index].status)
  if (expectedStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const updated = withStatus(
    rows[index],
    meta,
    target,
    NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  )
  const nextRows = [...rows]
  nextRows[index] = updated

  const changes = [{ key, rows: nextRows }]

  // 另一个入口（替代设备台账）同步同一条记录的可用结论，一次写入落库。
  const replacementKey = REPLACEMENT_LEDGER[key]
  let replacementMeta: ModuleMeta | undefined
  let replacementRows: EntryRow[] | undefined
  if (replacementKey) {
    replacementMeta = MODULE_BY_KEY.get(replacementKey)
    const field = replacementMeta ? statusFieldFor(replacementKey) : undefined
    replacementRows = listRows(replacementKey)
    const replacedTarget = replacementStatusFor(target)
    replacementRows = replacementRows.map((row) =>
      Number(row.id) === id && replacementMeta && field
        ? withStatus(row, replacementMeta, replacedTarget, updated.abnormal)
        : row,
    )
    changes.push({ key: replacementKey, rows: replacementRows })
  }

  // 并发提交：以进入动作时的状态为条件，只有首个提交能写进去，后续提交原样驳回。
  const accepted = commitMany(changes, { key, id, expectedStatus })
  if (!accepted) {
    const latest = listRows(key).find((row) => Number(row.id) === id)
    return {
      ok: false,
      message: latest
        ? `${meta.entity}已被先到的提交更新为「${latest.status}」，本次操作未生效`
        : `${meta.entity}状态已变化，请刷新后重试`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
