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
// controls (e.g. delete buttons for EDB rows). Optional `caption` /
// `title` overrides the default header label.

import { useMemo, useState } from 'react'
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { Program, RelDecl } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
import type { ReactNode } from 'react'
import { Store, useLiveQuery } from '../lib/store.js'
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

export function RelationTable({
  store,
  program,
  relation,
  actions,
  title,
}: RelationTableProps): JSX.Element {
  const rows = useLiveQuery<Row>(store, relation)
  const decl = useMemo(() => findDecl(program, relation), [program, relation])
  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (!decl) return []
    const cols: ColumnDef<Row>[] = decl.attributes.map((attr, i) => ({
      id: attr.name,
      header: attr.name,
      accessorFn: (row: Row) => row[i],
      cell: (info) => info.getValue() as number,
    }))
    if (actions) {
      cols.push({
        id: '_actions',
        header: '',
        enableSorting: false,
        cell: (info) => actions(info.row.original),
      })
    }
    return cols
  }, [decl, actions])

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
              return (
                <th
                  key={h.id}
                  onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                  className={canSort ? styles.sortable : undefined}
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
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

function findDecl(program: Program, name: string): RelDecl | undefined {
  return (
    program.edbs.find((d) => d.name === name) ??
    program.idbs.find((d) => d.name === name)
  )
}
