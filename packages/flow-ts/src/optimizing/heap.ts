// Small max-heap. Used by the join-tree optimizer (Prim's MST variant).
//
// `compare(a, b) > 0` means `a` is the higher-priority element.

export class MaxHeap<T> {
  private readonly data: T[] = []

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.data.length
  }

  push(v: T): void {
    this.data.push(v)
    this.siftUp(this.data.length - 1)
  }

  pop(): T | undefined {
    const n = this.data.length
    if (n === 0) return undefined
    const top = this.data[0]!
    const last = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = last
      this.siftDown(0)
    }
    return top
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.compare(this.data[i]!, this.data[parent]!) > 0) {
        const tmp = this.data[i]!
        this.data[i] = this.data[parent]!
        this.data[parent] = tmp
        i = parent
      } else {
        break
      }
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length
    for (;;) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let largest = i
      if (left < n && this.compare(this.data[left]!, this.data[largest]!) > 0) {
        largest = left
      }
      if (right < n && this.compare(this.data[right]!, this.data[largest]!) > 0) {
        largest = right
      }
      if (largest === i) break
      const tmp = this.data[i]!
      this.data[i] = this.data[largest]!
      this.data[largest] = tmp
      i = largest
    }
  }
}
