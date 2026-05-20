// Generic, schema-driven table view for any flow-ts relation (EDB or
// IDB). Drives its column headers from the program's `.decl Foo(a, b)`
// declaration, subscribes to the live row set via `useLiveQuery`, and
// renders through Tanstack Table so it gets sortable columns for free.
//
// Usage:
//
//     <RelationTable store={store} program={program} relation="Reach" />
//
// Optional `actions(row)` adds a render-prop column for per-row
// controls (e.g. delete buttons for EDB rows). For EDBs the table
// also grows an inline add-row at the bottom — type values into each
// column's input and press Enter (or click "add") to insert. IDBs are
// read-only.

import { useMemo, useState, type ReactNode } from 'react'
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { Program, RelDecl } from '@flow-ts/parsing'
import { codecFor, type Row, type Value } from '@flow-ts/reading'
import { Store, useLiveQuery } from '@flow-ts/react'
import styles from './RelationTable.module.css'

export interface RelationTableProps {
  store: Store
  program: Program
  /** EDB or IDB name as declared in the program. */
  relation: string
  /** Optional render-prop for an extra trailing column. Receives the
   *  raw row tuple. Used for action buttons (e.g. delete an EDB row). */
  actions?: (row: Row) => ReactNode
  /** Override the table's default `<caption>` text. */
  title?: string
}

/** Column-def `meta` we use to thread a CSS-module class through the
 *  Tanstack column model so headers / cells get the same per-column
 *  styling without a fragile column-index check at render time. */
interface ColumnMeta {
  /** CSS-module class applied to the column's `<th>` and `<td>`. */
  className?: string
}

export function RelationTable({
  store,
  program,
  relation,
  actions,
  title,
}: RelationTableProps): JSX.Element {
  const rows = useLiveQuery<Row>(store, relation)
  const decl = useMemo(() => findDecl(program, relation), [program, relation])
  const isEdb = useMemo(
    () => program.edbs.some((e) => e.name === relation),
    [program, relation],
  )
  // EDB tables always carry a trailing "actions" column (so the inline
  // add-row's submit button has a home). IDBs only need the column when
  // the caller passes an `actions` render-prop.
  const hasActionsColumn = isEdb || !!actions

  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (!decl) return []
    const cols: ColumnDef<Row>[] = decl.attributes.map((attr, i) => ({
      id: attr.name,
      header: attr.name,
      accessorFn: (row: Row) => row[i],
      cell: (info) => String(info.getValue()),
    }))
    if (hasActionsColumn) {
      cols.push({
        id: '_actions',
        header: '',
        enableSorting: false,
        meta: { className: styles.actionsCell } satisfies ColumnMeta,
        cell: (info) => (actions ? actions(info.row.original) : null),
      })
    }
    return cols
  }, [decl, actions, hasActionsColumn])

  const table = useReactTable({
    data: rows as Row[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (!decl) {
    return <p className="muted">unknown relation: {relation}</p>
  }

  const schema = decl.attributes.map((a) => `${a.name}: ${a.dataType}`).join(', ')
  return (
    <table className={styles.table} data-testid={`relation-table-${relation}`}>
      <caption className={styles.caption}>
        <span className={styles.captionInner}>
          <span className={styles.relName}>{title ?? relation}</span>
          <span className={styles.relSchema}>({schema})</span>
          <span className={styles.relCount} data-testid={`relation-count-${relation}`}>
            {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          </span>
        </span>
      </caption>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((h) => {
              const canSort = h.column.getCanSort()
              const sort = h.column.getIsSorted()
              const meta = h.column.columnDef.meta as ColumnMeta | undefined
              return (
                <th
                  key={h.id}
                  onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                  className={joinClasses(canSort && styles.sortable, meta?.className)}
                  aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none'}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {sort === 'asc' && <span className={styles.sort}>▲</span>}
                  {sort === 'desc' && <span className={styles.sort}>▼</span>}
                </th>
              )
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className={styles.empty}>(no rows)</td>
          </tr>
        ) : (
          table.getRowModel().rows.map((row) => (
            <tr key={row.id} data-testid={`relation-row-${relation}-${row.original.join('-')}`}>
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as ColumnMeta | undefined
                return (
                  <td key={cell.id} className={meta?.className}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                )
              })}
            </tr>
          ))
        )}
      </tbody>
      {isEdb && <AddRow store={store} decl={decl} hasActionsColumn={hasActionsColumn} />}
    </table>
  )
}

/** Render-form for inserting a new EDB row. One input per column,
 *  submit by clicking the button or pressing Enter in any input. */
function AddRow({
  store,
  decl,
  hasActionsColumn,
}: {
  store: Store
  decl: RelDecl
  hasActionsColumn: boolean
}): JSX.Element {
  const [values, setValues] = useState<string[]>(() => decl.attributes.map(() => ''))

  const submit = () => {
    const row: Value[] = []
    for (let i = 0; i < values.length; i++) {
      const raw = values[i]!.trim()
      if (raw === '') return // any empty cell bails silently
      const attr = decl.attributes[i]!
      try {
        row.push(codecFor(attr.dataType).fromText(raw))
      } catch {
        return // invalid (e.g. non-numeric in a number column)
      }
    }
    store.update(decl.name, row, +1)
    setValues(decl.attributes.map(() => ''))
  }

  return (
    <tfoot>
      <tr className={styles.addRow} data-testid={`add-row-${decl.name}`}>
        {decl.attributes.map((attr, i) => {
          // Pick the right input affordance per column type. `type="number"`
          // surfaces a numeric keypad on mobile and rejects most non-numeric
          // input at the browser level; `step="any"` lets floats use the
          // arrow controls without snapping. Strings stay on plain text.
          const isFloat = attr.dataType === 'Float'
          const isInt = attr.dataType === 'Integer'
          const inputType = isFloat || isInt ? 'number' : 'text'
          return (
            <td key={attr.name}>
              <input
                className={styles.addInput}
                type={inputType}
                step={isFloat ? 'any' : undefined}
                inputMode={isFloat ? 'decimal' : isInt ? 'numeric' : undefined}
                value={values[i] ?? ''}
                onChange={(e) => {
                  const next = [...values]
                  next[i] = e.target.value
                  setValues(next)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder={attr.name}
                aria-label={`new ${decl.name} ${attr.name}`}
                data-testid={`add-${decl.name}-${attr.name}`}
              />
            </td>
          )
        })}
        {hasActionsColumn && (
          <td className={styles.actionsCell}>
            <button
              className={styles.addButton}
              onClick={submit}
              data-testid={`add-${decl.name}-submit`}
            >
              add
            </button>
          </td>
        )}
      </tr>
    </tfoot>
  )
}

function findDecl(program: Program, name: string): RelDecl | undefined {
  return (
    program.edbs.find((d) => d.name === name) ??
    program.idbs.find((d) => d.name === name)
  )
}

function joinClasses(...parts: Array<string | false | undefined | null>): string | undefined {
  const out = parts.filter(Boolean).join(' ')
  return out === '' ? undefined : out
}
