// The codec for `any` columns.
//
// Most of `any` costs nothing, because the wire format has been
// self-describing from the start: a string field carries a leading `'`, a
// number starts with a digit or `-`, and `decodeRow` has never consulted the
// schema. So encoding, decoding, keying and joining an `any` cell is the
// dispatch that was already there.
//
// The exception is `fromText`. A CSV cell is text and nothing else, so
// something has to decide whether `42` is the number or the string, and that
// decision is the only part of this feature with a defensible alternative.
// These tests pin the rule and the edges around it.

import { describe, expect, it } from 'vitest'
import { codecFor, codecForFieldChar } from '../../src/reading/value.js'
import { decodeRow, encodeRow } from '../../src/reading/encoding.js'

const any = codecFor('Any')

describe('fromText: reading an untyped cell', () => {
  it('reads a cell that is wholly a finite number as a number', () => {
    expect(any.fromText('42')).toBe(42)
    expect(any.fromText('-7')).toBe(-7)
    expect(any.fromText('3.14')).toBe(3.14)
    expect(any.fromText('1e3')).toBe(1000)
  })

  it('reads anything else as a string', () => {
    expect(any.fromText('alice')).toBe('alice')
    expect(any.fromText('42x')).toBe('42x')
    expect(any.fromText('4,2')).toBe('4,2')
    // Not finite, so not a number we would want to do arithmetic on.
    expect(any.fromText('Infinity')).toBe('Infinity')
    expect(any.fromText('NaN')).toBe('NaN')
  })

  it('keeps an empty cell as the empty string', () => {
    // `Number('')` is 0 and `Number(' ')` is 0, so without the guard every
    // blank cell in a CSV would arrive as a zero.
    expect(any.fromText('')).toBe('')
  })

  it('loses the leading zeros of a padded code — the cost of inferring', () => {
    // Stated rather than fixed: `any` is for a column whose shape you don't
    // know. A column of zero-padded codes has a shape, and `string` says so.
    expect(any.fromText('007')).toBe(7)
    expect(codecFor('String').fromText('007')).toBe('007')
  })
})

describe('the wire format needs no help', () => {
  it('round-trips both kinds through the same codec', () => {
    for (const v of [42, -7, 3.14, 0, 'alice', '', "with 'quote", 'a,b', 'back\\slash']) {
      expect(any.decodeField(any.encodeField(v))).toEqual(v)
    }
  })

  it('encodes exactly as the concrete codecs do, so rows key identically', () => {
    // This is what lets an `any` column join a typed one: the bytes are the
    // same, so the Map key is the same.
    expect(any.encodeField(42)).toBe(codecFor('Integer').encodeField(42))
    expect(any.encodeField('alice')).toBe(codecFor('String').encodeField('alice'))
    expect(encodeRow([42, 'alice'])).toBe(any.encodeField(42) + ',' + any.encodeField('alice') + ',')
  })

  it('keeps a numeric string distinct from the number', () => {
    // They are different values and must not collide as join keys.
    expect(any.encodeField('42')).not.toBe(any.encodeField(42))
    expect(decodeRow(encodeRow(['42', 42]))).toEqual(['42', 42])
  })

  it('is not consulted by the tag dispatch, which stays unambiguous', () => {
    // `any` matches both tags, so putting it in the dispatch would make the
    // lookup order load-bearing. The concrete codecs answer instead.
    expect(any.matches("'")).toBe(true)
    expect(any.matches('4')).toBe(true)
    expect(codecForFieldChar("'")).toBe(codecFor('String'))
    expect(codecForFieldChar('4')).toBe(codecFor('Integer'))
  })
})

describe('fromConst', () => {
  it('lowers whichever literal it is handed', () => {
    expect(any.fromConst({ kind: 'Integer', value: 5 })).toBe(5)
    expect(any.fromConst({ kind: 'Float', value: 2.5 })).toBe(2.5)
    expect(any.fromConst({ kind: 'Text', value: 'hi' })).toBe('hi')
    // …where the typed codecs refuse the ones that aren't theirs.
    expect(() => codecFor('String').fromConst({ kind: 'Integer', value: 5 })).toThrow()
  })
})
