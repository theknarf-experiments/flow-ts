// Port of flowlog/src/optimizing/src/optimizer.rs
//
// PlanTree represents the join order for a rule's core atoms as a tree
// rooted at one atom. `fromCatalog(catalog, isOptimized)` returns a default
// chain tree, or — when `isOptimized` is true — searches for the lowest-width
// (tie-broken by depth) tree across all candidate roots and child orderings.
// Width is computed recursively via the "planning child" partition rule.

import type { Catalog } from '../catalog/index.js'
import { MaxHeap } from './heap.js'

/** Sentinel for the "no parent" entry seeded onto the Prim's-MST heap. */
const NO_PARENT = -1

type HeapEntry = {
  overlap: number
  depth: number
  parent: number
  child: number
}

/**
 * Comparator that matches the Rust BinaryHeap ordering of
 *   (overlap, Reverse(depth), parent, child)
 * — i.e. higher overlap first, then lower depth, then higher parent / child.
 */
function compareHeapEntry(a: HeapEntry, b: HeapEntry): number {
  if (a.overlap !== b.overlap) return a.overlap - b.overlap
  if (a.depth !== b.depth) return b.depth - a.depth
  if (a.parent !== b.parent) return a.parent - b.parent
  return a.child - b.child
}

export class PlanTree {
  private constructor(
    public readonly root: number,
    public readonly tree: Map<number, number[]>,
    public readonly overlap: number,
    public readonly maxOverlap: number,
    public readonly subTrees: Map<number, number[]>,
    public readonly treeWidth: number,
  ) {}

  /** True for trees whose joins cover all shared-variable edges (acyclic queries). */
  isAcyclic(): boolean {
    if (this.overlap > this.maxOverlap) {
      throw new Error('overlap exceeds max_overlap — invariant violated')
    }
    return this.overlap === this.maxOverlap
  }

  isLeaf(x: number): boolean {
    return (this.tree.get(x) ?? []).length === 0
  }

  children(x: number): number[] {
    const c = this.tree.get(x)
    if (!c) throw new Error(`no children entry for node ${x}`)
    return c
  }

  static fromCatalog(catalog: Catalog, isOptimized: boolean): PlanTree {
    const atomVariableSets: Set<string>[] = catalog.atomArgumentSignatures.map(
      (signatures, i) => {
        if (!catalog.isCoreAtomBitmap[i]) return new Set<string>()
        return new Set(catalog.signatureToArgumentStrs(signatures))
      },
    )

    const lambdaOverlap = (from: number, to: number): number => {
      const a = atomVariableSets[from]!
      const b = atomVariableSets[to]!
      let count = 0
      const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
      for (const v of smaller) if (larger.has(v)) count++
      return count
    }

    const headVariableSet = new Set(catalog.headArgumentsStrs())

    const coreAtoms: number[] = []
    for (let i = 0; i < catalog.isCoreAtomBitmap.length; i++) {
      if (catalog.isCoreAtomBitmap[i]) coreAtoms.push(i)
    }

    if (coreAtoms.length === 0) {
      throw new Error(`No core atoms for the rule ${catalog.rule.toString()}`)
    }

    // Default chain tree: last core atom as root, prior atoms threaded back.
    //   coreAtoms = [0, 1, 2, 3]  →  3 → 2 → 1 → 0
    let root = coreAtoms[coreAtoms.length - 1]!
    let tree: Map<number, number[]> = new Map()
    let overlap = 0
    for (let i = coreAtoms.length - 1; i > 0; i--) {
      const parent = coreAtoms[i]!
      const child = coreAtoms[i - 1]!
      tree.set(parent, [child])
      overlap += lambdaOverlap(parent, child)
    }
    tree.set(coreAtoms[0]!, [])

    let width = PlanTree.populateTreeWidth(
      catalog,
      root,
      tree,
      atomVariableSets,
      headVariableSet,
    )
    let depth = PlanTree.populateTreeDepth(root, tree)

    if (isOptimized) {
      for (let candidateRoot = 0; candidateRoot < atomVariableSets.length; candidateRoot++) {
        if (!catalog.isCoreAtomBitmap[candidateRoot]) continue

        // Prim's: maximum spanning tree by overlap, with the candidate root.
        const visited = catalog.isCoreAtomBitmap.map((c) => !c)
        const candidateTree = new Map<number, number[]>()
        const heap = new MaxHeap<HeapEntry>(compareHeapEntry)
        heap.push({ overlap: 0, depth: 0, parent: NO_PARENT, child: candidateRoot })
        let candidateOverlap = 0

        while (heap.size > 0) {
          const { overlap: prevOverlap, depth: childDepth, parent: parentId, child: childId } = heap.pop()!
          if (visited[childId]) continue
          visited[childId] = true

          if (parentId === NO_PARENT) {
            candidateTree.set(childId, [])
          } else {
            const parentChildren = candidateTree.get(parentId)
            if (!parentChildren) {
              throw new Error(`Prim's: parent ${parentId} not yet inserted`)
            }
            parentChildren.push(childId)
            candidateTree.set(childId, [])
            candidateOverlap += prevOverlap
          }

          for (let neighborId = 0; neighborId < visited.length; neighborId++) {
            if (visited[neighborId]) continue
            const nextOverlap = lambdaOverlap(childId, neighborId)
            if (nextOverlap > 0) {
              heap.push({
                overlap: nextOverlap,
                depth: childDepth + 1,
                parent: childId,
                child: neighborId,
              })
            } else {
              // No overlap → connect to candidate root at depth 1.
              heap.push({
                overlap: 0,
                depth: 1,
                parent: candidateRoot,
                child: neighborId,
              })
            }
          }
        }

        // Normalize child order to match the Rust `sort_unstable` step.
        for (const [, children] of candidateTree) {
          children.sort((a, b) => a - b)
        }

        // Try every child-order permutation; keep the best (width, depth).
        for (const permutedTree of PlanTree.treePermutations(candidateTree)) {
          const candidateWidth = PlanTree.populateTreeWidth(
            catalog,
            candidateRoot,
            permutedTree,
            atomVariableSets,
            headVariableSet,
          )
          const candidateDepth = PlanTree.populateTreeDepth(candidateRoot, permutedTree)
          if (
            candidateWidth < width ||
            (candidateWidth === width && candidateDepth < depth)
          ) {
            tree = permutedTree
            width = candidateWidth
            depth = candidateDepth
            overlap = candidateOverlap
            root = candidateRoot
          }
        }
      }
    }

    const subTrees = new Map<number, number[]>()
    for (let x = 0; x < atomVariableSets.length; x++) {
      if (catalog.isCoreAtomBitmap[x]) {
        PlanTree.populateSubtree(x, tree, subTrees)
      }
    }

    // max_overlap = sum of core arities - number of distinct core variables.
    let arityTotal = 0
    const distinct = new Set<string>()
    for (const set of atomVariableSets) {
      arityTotal += set.size
      for (const v of set) distinct.add(v)
    }
    const maxOverlap = arityTotal - distinct.size

    return new PlanTree(root, tree, overlap, maxOverlap, subTrees, width)
  }

  private static populateSubtree(
    subroot: number,
    tree: Map<number, number[]>,
    subTrees: Map<number, number[]>,
  ): number[] {
    const cached = subTrees.get(subroot)
    if (cached) return cached
    const subtree: number[] = [subroot]
    const children = tree.get(subroot) ?? []
    for (const child of children) {
      subtree.push(...PlanTree.populateSubtree(child, tree, subTrees))
    }
    subTrees.set(subroot, subtree)
    return subtree
  }

  private static populateTreeDepth(
    root: number,
    tree: Map<number, number[]>,
  ): number {
    const go = (parent: number): number => {
      const children = tree.get(parent) ?? []
      if (children.length === 0) return 0
      let max = 0
      for (const child of children) {
        const d = go(child)
        if (d > max) max = d
      }
      return 1 + max
    }
    return go(root)
  }

  private static populateTreeWidth(
    catalog: Catalog,
    root: number,
    tree: Map<number, number[]>,
    atomVariableSets: readonly Set<string>[],
    headVariables: ReadonlySet<string>,
  ): number {
    const subTrees = new Map<number, number[]>()
    for (let x = 0; x < atomVariableSets.length; x++) {
      if (catalog.isCoreAtomBitmap[x]) {
        PlanTree.populateSubtree(x, tree, subTrees)
      }
    }

    const subtreeWidth = (
      parent: number,
      currentTree: Map<number, number[]>,
      headVars: ReadonlySet<string>,
    ): number => {
      const children = currentTree.get(parent) ?? []
      if (children.length === 0) return 0

      const planningChild = children[children.length - 1]!
      const planningSubtree = subTrees.get(planningChild)
      if (!planningSubtree) {
        throw new Error(`subtree missing for child ${planningChild}`)
      }

      const leftover: number[] = [parent]
      for (let k = 0; k < children.length - 1; k++) {
        const subtree = subTrees.get(children[k]!)
        if (subtree) leftover.push(...subtree)
      }

      const planningVarsSet = catalog.varsSet(planningSubtree)
      const leftoverVarsSet = catalog.varsSet(leftover)

      const planningHeadVariables = intersect(
        planningVarsSet,
        union(leftoverVarsSet, headVars),
      )
      const leftoverHeadVariables = intersect(
        leftoverVarsSet,
        union(planningVarsSet, headVars),
      )

      // Drop the planning child from this parent's child list, then recurse.
      const truncatedTree = new Map<number, number[]>()
      for (const [k, v] of currentTree) truncatedTree.set(k, [...v])
      const truncatedChildren = truncatedTree.get(parent)!
      truncatedChildren.pop()

      const planningWidth = subtreeWidth(planningChild, truncatedTree, planningHeadVariables)
      const leftoverWidth = subtreeWidth(parent, truncatedTree, leftoverHeadVariables)

      const joinWidth = union(planningHeadVariables, leftoverHeadVariables).size
      return Math.max(planningWidth, leftoverWidth, joinWidth)
    }

    return subtreeWidth(root, tree, headVariables)
  }

  /** All permutations of each parent's children list. */
  private static treePermutations(
    tree: Map<number, number[]>,
  ): Map<number, number[]>[] {
    let perms: Map<number, number[]>[] = [PlanTree.cloneTree(tree)]
    for (const [parent, children] of tree) {
      const childPerms = permutations(children)
      const next: Map<number, number[]>[] = []
      for (const childPerm of childPerms) {
        for (const t of perms) {
          const cloned = PlanTree.cloneTree(t)
          cloned.set(parent, [...childPerm])
          next.push(cloned)
        }
      }
      perms = next
    }
    return perms
  }

  private static cloneTree(tree: Map<number, number[]>): Map<number, number[]> {
    const out = new Map<number, number[]>()
    for (const [k, v] of tree) out.set(k, [...v])
    return out
  }

  toString(): string {
    const lines: string[] = []
    const recur = (node: number, prefix: string, isLast: boolean): void => {
      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${node}`)
      const childPrefix = prefix + (isLast ? '    ' : '│   ')
      const children = this.tree.get(node) ?? []
      for (let i = 0; i < children.length; i++) {
        recur(children[i]!, childPrefix, i === children.length - 1)
      }
    }
    recur(this.root, '', true)
    return lines.join('\n')
  }
}

function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>(a)
  for (const v of b) out.add(v)
  return out
}

function intersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>()
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  for (const v of smaller) if (larger.has(v)) out.add(v)
  return out
}

function permutations<T>(arr: readonly T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest: T[] = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const p of permutations(rest)) {
      out.push([arr[i]!, ...p])
    }
  }
  return out
}
