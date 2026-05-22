// Port of flowlog/src/strata/src/stratification.rs
//
// Two-pass stratification:
//   1. Kosaraju's algorithm finds SCCs of the rule dependency graph; each
//      SCC of size > 1 (or with a self-loop) is marked recursive.
//   2. Merge independent non-recursive strata in topological order; each
//      recursive stratum stays separate.

import type { FLRule, Program } from '@flow-ts/parsing'
import { DependencyGraph } from './dependencies.js'

export class Strata {
  private constructor(
    public readonly flProgram: Program,
    public readonly dependencyGraph: DependencyGraph,
    private readonly strataIds: number[][],
    private readonly recursiveBitmap: boolean[],
  ) {}

  static transposeGraphFrom(
    ruleDependencyMap: Map<number, Set<number>>,
  ): Map<number, Set<number>> {
    const transpose = new Map<number, Set<number>>()
    for (const [ruleId, deps] of ruleDependencyMap) {
      for (const dep of deps) {
        let s = transpose.get(dep)
        if (!s) {
          s = new Set()
          transpose.set(dep, s)
        }
        s.add(ruleId)
      }
    }
    return transpose
  }

  static processingOrderDfs(
    order: number[],
    visited: boolean[],
    ruleDependencyMap: Map<number, Set<number>>,
    ruleId: number,
  ): void {
    if (visited[ruleId]) return
    visited[ruleId] = true
    const deps = ruleDependencyMap.get(ruleId)
    if (deps) {
      for (const dep of deps) {
        Strata.processingOrderDfs(order, visited, ruleDependencyMap, dep)
      }
    }
    order.push(ruleId)
  }

  static assigningSccDfs(
    transposeGraph: Map<number, Set<number>>,
    ruleSccs: Map<number, number[]>,
    sccsOrder: number[],
    ruleAssigned: boolean[],
    ruleId: number,
    sccId: number,
  ): void {
    if (ruleAssigned[ruleId]) return
    ruleAssigned[ruleId] = true

    let scc = ruleSccs.get(sccId)
    if (!scc) {
      sccsOrder.push(sccId)
      scc = []
      ruleSccs.set(sccId, scc)
    }
    scc.push(ruleId)

    const reverseDeps = transposeGraph.get(ruleId)
    if (reverseDeps) {
      for (const rev of reverseDeps) {
        Strata.assigningSccDfs(
          transposeGraph,
          ruleSccs,
          sccsOrder,
          ruleAssigned,
          rev,
          sccId,
        )
      }
    }
  }

  static fromParser(program: Program): Strata {
    const dependencyGraph = DependencyGraph.fromParser(program)
    const ruleDependencyMap = dependencyGraph.ruleDependencyMap

    // First DFS — post-order over the dependency graph.
    const ruleVisited: boolean[] = new Array(ruleDependencyMap.size).fill(false)
    const processingOrder: number[] = []
    for (const ruleId of ruleDependencyMap.keys()) {
      Strata.processingOrderDfs(processingOrder, ruleVisited, ruleDependencyMap, ruleId)
    }
    processingOrder.reverse()

    // Second DFS — over the transpose, in reverse-post-order, assigns SCCs.
    const transposeGraph = Strata.transposeGraphFrom(ruleDependencyMap)
    const ruleSccs = new Map<number, number[]>()
    const sccsOrder: number[] = []
    const ruleAssigned: boolean[] = new Array(processingOrder.length).fill(false)
    for (const ruleId of processingOrder) {
      Strata.assigningSccDfs(
        transposeGraph,
        ruleSccs,
        sccsOrder,
        ruleAssigned,
        ruleId,
        ruleId,
      )
    }

    // Topological order of SCCs.
    sccsOrder.reverse()

    // Initial strata + recursion bitmap.
    const initialStrata: number[][] = []
    const initialRecursive: boolean[] = []
    for (const sccId of sccsOrder) {
      const scc = ruleSccs.get(sccId)
      if (!scc) continue
      initialStrata.push(scc)
      const hasSelfLoop = ruleDependencyMap.get(sccId)?.has(sccId) ?? false
      initialRecursive.push(scc.length > 1 || hasSelfLoop)
    }

    // Merge pass: collapse independent non-recursive strata; keep recursive
    // strata as their own steps. Strata are processed in topological waves —
    // each wave contains strata whose dependencies (outside themselves) have
    // already been merged.
    const strataDependencies: Set<number>[] = initialStrata.map((stratum) => {
      const out = new Set<number>()
      for (const ruleId of stratum) {
        const deps = ruleDependencyMap.get(ruleId)
        if (!deps) continue
        for (const dep of deps) {
          if (!stratum.includes(dep)) out.add(dep)
        }
      }
      return out
    })

    const merged: boolean[] = new Array(initialStrata.length).fill(false)
    const mergers: number[][] = []
    const isRecursiveMergerBitmap: boolean[] = []

    while (merged.some((m) => !m)) {
      const nextNonRecursive: number[] = []
      const nextRecursive: number[][] = []
      for (let i = 0; i < initialStrata.length; i++) {
        if (!merged[i] && strataDependencies[i]!.size === 0) {
          merged[i] = true
          const stratum = initialStrata[i]!
          if (initialRecursive[i]) {
            nextRecursive.push([...stratum])
          } else {
            nextNonRecursive.push(...stratum)
          }
        }
      }

      // Drop dependencies now satisfied by the strata we just merged.
      const justMerged = new Set<number>(nextNonRecursive)
      for (const stratum of nextRecursive) {
        for (const ruleId of stratum) justMerged.add(ruleId)
      }
      for (const deps of strataDependencies) {
        for (const ruleId of [...deps]) {
          if (justMerged.has(ruleId)) deps.delete(ruleId)
        }
      }

      if (nextNonRecursive.length > 0) {
        mergers.push(nextNonRecursive)
        isRecursiveMergerBitmap.push(false)
      }
      for (const stratum of nextRecursive) {
        mergers.push(stratum)
        isRecursiveMergerBitmap.push(true)
      }
    }

    return new Strata(program, dependencyGraph, mergers, isRecursiveMergerBitmap)
  }

  /** Resolve stratum rule-IDs into the actual rules from the program. */
  strata(): FLRule[][] {
    const program = this.flProgram
    return this.strataIds.map((ids) => ids.map((id) => program.rules[id]!))
  }

  /** Stratum partition as rule indices (parallel to `strata()`). */
  strataIndices(): readonly (readonly number[])[] {
    return this.strataIds
  }

  isRecursiveStratum(stratumId: number): boolean {
    const v = this.recursiveBitmap[stratumId]
    if (v === undefined) {
      throw new Error(`stratum index out of range: ${stratumId}`)
    }
    return v
  }

  get isRecursiveStrataBitmap(): readonly boolean[] {
    return this.recursiveBitmap
  }

  toString(): string {
    const lines: string[] = []
    for (let stratumId = 0; stratumId < this.strataIds.length; stratumId++) {
      const stratum = this.strataIds[stratumId]!
      const sortedIds = [...stratum].sort((a, b) => a - b)
      lines.push(`#${stratumId + 1}: [${sortedIds.join(', ')}]`)
      for (const ruleId of stratum) {
        lines.push(this.flProgram.rules[ruleId]!.toString())
      }
      lines.push('')
    }
    return lines.join('\n')
  }
}
