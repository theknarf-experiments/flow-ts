// `flow-ts inspect <prog.dl>` — dump the parsed program, its
// stratification, and the execution plan. Useful when debugging why a
// rule isn't firing, or why a head ends up in a recursive stratum.
//
// Text output is the default; `--json` emits a structured object for
// pipe-into-jq workflows. No fact files are read — inspect operates
// purely on the program.

import * as fs from 'node:fs'
import { aggregationCatalogFromProgram } from 'flow-ts'
import { parseProgram } from '@flow-ts/parsing'
import type { Program } from '@flow-ts/parsing'
import {
  ProgramQueryPlan,
  type Transformation,
  binaryInputs,
  isUnary,
  transformationOutput,
  unaryInput,
} from 'flow-ts'
import type { FLRule } from '@flow-ts/parsing'
import { Strata } from 'flow-ts'

export interface InspectOptions {
  /** Emit JSON instead of human-readable text. */
  json?: boolean
  /** Optimisation level to pass to the planner. Matches the batch CLI. */
  optLevel?: number | null
  /** Disable transformation-output sharing across rules. */
  noSharing?: boolean
}

/** Read + parse the program, then emit a structured description. */
export function runInspect(
  programPath: string,
  options: InspectOptions = {},
  output: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): void {
  const source = fs.readFileSync(programPath, 'utf8')
  const program = parseProgram(source, { grammarSource: programPath })
  const strata = Strata.fromParser(program)
  const plan = ProgramQueryPlan.fromStrata(
    strata,
    options.noSharing ?? false,
    options.optLevel ?? null,
  )
  const aggCatalog = aggregationCatalogFromProgram(program)

  if (options.json) {
    output(JSON.stringify(buildJsonReport(programPath, program, strata, plan, aggCatalog), null, 2))
    return
  }

  for (const line of buildTextReport(programPath, program, strata, plan, aggCatalog)) {
    output(line)
  }
}

// ---------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------

function* buildTextReport(
  programPath: string,
  program: Program,
  strata: Strata,
  plan: ProgramQueryPlan,
  aggCatalog: ReadonlyMap<string, unknown>,
): Generator<string> {
  yield `Program: ${programPath}`
  yield '========'
  yield ''
  yield `EDBs (${program.edbs.length}):`
  for (const edb of program.edbs) {
    const filePath = edb.path ? ` [${edb.path}]` : ''
    yield `  ${edb.toString()}${filePath}`
  }
  yield ''
  yield `IDBs (${program.idbs.length}):`
  for (const idb of program.idbs) yield `  ${idb.toString()}`
  yield ''
  yield `Rules (${program.rules.length}):`
  for (let i = 0; i < program.rules.length; i++) {
    yield `  [${i}] ${program.rules[i]!.toString()}`
  }
  yield ''

  yield 'Strata'
  yield '======'
  yield ''
  const stratumRules = strata.strata()
  for (let i = 0; i < stratumRules.length; i++) {
    const ruleIds = strata.strataIndices()[i]!
    const kind = strata.isRecursiveStratum(i) ? 'recursive' : 'non-recursive'
    yield `#${i} ${kind} [${ruleIds.length} rule${ruleIds.length === 1 ? '' : 's'}]`
    for (const rule of stratumRules[i]!) {
      yield `  ${rule.toString()}`
    }
    yield ''
  }

  yield 'Plan'
  yield '===='
  yield ''
  for (let i = 0; i < plan.programPlan.length; i++) {
    const g = plan.programPlan[i]!
    yield `Stratum #${i} ${g.isRecursive ? 'recursive' : 'non-recursive'}`
    yield `  Heads: ${[...g.headSignaturesSet()].join(', ') || '(none)'}`
    const enterScope = [...g.enterScope]
    yield `  Enter scope: ${enterScope.length === 0 ? '(none)' : enterScope.join(', ')}`
    for (let r = 0; r < g.strataPlan.length; r++) {
      const tx = g.strataPlan[r]!
      if (tx.length === 0) continue
      yield `  Rule ${r} (${tx.length} transformation${tx.length === 1 ? '' : 's'}):`
      for (let ti = 0; ti < tx.length; ti++) {
        yield `    [${ti}] ${describeTransformation(tx[ti]!)}`
      }
    }
    yield ''
  }

  yield `Aggregation catalog (${aggCatalog.size}):`
  if (aggCatalog.size === 0) {
    yield '  (none)'
  } else {
    for (const [name, agg] of aggCatalog) {
      const desc = (agg as { aggregationArgument: { toString(): string } }).aggregationArgument.toString()
      yield `  ${name}: ${desc}`
    }
  }
}

// ---------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------

interface JsonReport {
  program: { path: string; edbs: string[]; idbs: string[]; rules: string[] }
  strata: Array<{ index: number; recursive: boolean; ruleIds: number[]; rules: string[] }>
  plan: Array<{
    index: number
    recursive: boolean
    heads: string[]
    enterScope: string[]
    rules: Array<Array<{ kind: string; inputs: string; output: string }>>
  }>
  aggregations: Array<{ relation: string; expression: string }>
}

function buildJsonReport(
  programPath: string,
  program: Program,
  strata: Strata,
  plan: ProgramQueryPlan,
  aggCatalog: ReadonlyMap<string, unknown>,
): JsonReport {
  const stratumRules = strata.strata()
  return {
    program: {
      path: programPath,
      edbs: program.edbs.map((e) => e.toString()),
      idbs: program.idbs.map((i) => i.toString()),
      rules: program.rules.map((r) => r.toString()),
    },
    strata: stratumRules.map((rules: FLRule[], i: number) => ({
      index: i,
      recursive: strata.isRecursiveStratum(i),
      ruleIds: [...strata.strataIndices()[i]!],
      rules: rules.map((r: FLRule) => r.toString()),
    })),
    plan: plan.programPlan.map((g, i: number) => ({
      index: i,
      recursive: g.isRecursive,
      heads: [...g.headSignaturesSet()],
      enterScope: [...g.enterScope],
      rules: g.strataPlan.map((tx: Transformation[]) =>
        tx.map((t: Transformation) => ({
          kind: t.kind,
          inputs: transformationInputs(t),
          output: transformationOutput(t).signature.name,
        })),
      ),
    })),
    aggregations: [...aggCatalog].map(([rel, agg]) => ({
      relation: rel,
      expression: (agg as { aggregationArgument: { toString(): string } }).aggregationArgument.toString(),
    })),
  }
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function transformationInputs(t: Transformation): string {
  if (isUnary(t)) return unaryInput(t).signature.name
  const [l, r] = binaryInputs(t)
  return `${l.signature.name} ⋈ ${r.signature.name}`
}

function describeTransformation(t: Transformation): string {
  const out = transformationOutput(t).signature.name
  return `${t.kind.padEnd(11)} ${transformationInputs(t)} → ${out}`
}
