// Generic, schema-driven table view for any flow-ts relation (EDB or
// IDB). Adapted from example-web's RelationTable: drives its column
// headers from the program's `.decl Foo(a, b)` declaration, subscribes
// to the live row set via `useLiveQuery`, and renders through Tanstack
// Table so it gets sortable columns for free.
//
// Kanban-specific addition: a `badge` slot in the caption, used by the
// debug view to mark relations as synced (EDBs relayed through the
// server) or local (IDBs derived by the Datalog program).
//
// EDB tables grow an inline add-row at the bottom — type values into
// each column's input and press Enter (or click "add") to insert a raw
// fact, which flows through the sync bridge like any UI action. IDBs
// are read-only.

import { useMemo, useState, type ReactNode } from 'react'
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { codecFor, type Program, type RelDecl, type Row, type Value } from 'flow-ts'
import { Store, useLiveQuery } from '@flow-ts/react'
import styles from './RelationTable.module.css'

export interface RelationTableProps {
  store: Store
  program: Program
  /** EDB or IDB name as declared in the program. */
  relation: string
  /** Rendered in the caption after the schema — the debug view puts
   *  the synced/local badge here. */
  badge?: ReactNode
}

export function RelationTable({
  store,
  program,
  relation,
  badge,
}: RelationTableProps): JSX.Element {
  const rows = useLiveQuery<Row>(store, relation)
  const decl = useMemo(() => findDecl(program, relation), [program, relation])
  const isEdb = useMemo(
    () => program.edbs.some((e) => e.name === relation),
    [program, relation],
  )

  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (!decl) return []
    const cols: ColumnDef<Row>[] = decl.attributes.map((attr, i) => ({
      id: attr.name,
      header: attr.name,
      accessorFn: (row: Row) => row[i],
      cell: (info) => String(info.getValue()),
    }))
    // EDB tables carry a trailing column so the inline add-row's
    // submit button has a home.
    if (isEdb) {
      cols.push({
        id: '_actions',
        header: '',
        enableSorting: false,
        cell: () => null,
      })
    }
    return cols
  }, [decl, isEdb])

  const table = useReactTable({
    data: rows as Row[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (!decl) {
    return <p>unknown relation: {relation}</p>
  }

  const schema = decl.attributes.map((a) => `${a.name}: ${a.dataType}`).join(', ')
  return (
    <table className={styles.table} data-testid={`relation-table-${relation}`}>
      <caption className={styles.caption}>
        <span className={styles.captionInner}>
          <span className={styles.relName}>{relation}</span>
          <span className={styles.relSchema}>({schema})</span>
          {badge}
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
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
      {isEdb && <AddRow store={store} decl={decl} />}
    </table>
  )
}

/** Render-form for inserting a new EDB row. One input per column,
 *  submit by clicking the button or pressing Enter in any input. */
function AddRow({ store, decl }: { store: Store; decl: RelDecl }): JSX.Element {
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
        <td className={styles.actionsCell}>
          <button
            className={styles.addButton}
            onClick={submit}
            data-testid={`add-${decl.name}-submit`}
          >
            add
          </button>
        </td>
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
