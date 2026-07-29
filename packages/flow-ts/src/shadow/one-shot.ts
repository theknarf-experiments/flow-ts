// Answering one request against facts the caller holds, and keeping nothing.
//
// This is to `openBackwardSession` what `executeProgram` is to `openSession`:
// stand a graph up, load it, ask, throw it away. It was a second implementation
// of the whole protocol until it stopped being one, and the reason to fold it
// in is that the two had already drifted — every improvement to a message
// landed on one side only, so a session reported a truncated inverse as an
// aliasing conflict long after this had learnt to say what it actually was.
//
// The shape still earns its keep even though the capability no longer differs:
//
//   • Facts come from the caller. A session has to be fed and kept in step with
//     whatever the real source of truth is; this reads whatever it is handed,
//     so it cannot go stale. For a consumer whose facts live in a file, a
//     database or a CRDT — the vault demo re-parses its markdown on every
//     keystroke — that is the natural fit.
//   • The program can change between calls. A session holds a compiled graph,
//     and rebuilding it is the caller's problem; this compiles per request, so
//     editing the rules costs nothing extra.
//   • It scopes itself. The relation being asked about is right there in the
//     request, so only that view's channels are compiled. A session cannot do
//     that — its scope is a standing cost, so it has to be told up front.
//   • Nothing to own. A CLI doing one rewrite should not have to close a graph.

import type { Program } from '../ast/index.js'
import { type BackwardSession, openBackwardSession } from './session.js'
import type { BackwardRequest, Facts, Resolution, ResolveOptions } from './resolve.js'

/** Resolve a request against the given facts, verified by re-running the
 *  program, and leave nothing behind.
 *
 *  The caller's `facts` are read, never written: the changes come back in the
 *  `Resolution` for the caller to apply to whatever the facts were derived
 *  from. */
export function resolveBackward(
  program: Program,
  facts: Facts,
  request: BackwardRequest,
  options: ResolveOptions,
): Resolution {
  let session: BackwardSession
  try {
    session = openBackwardSession(program, {
      ...options,
      // Only the relation being asked about needs a channel. Building them for
      // every view would compile rules — and force the indexes behind them —
      // that this request can never reach, and a one-shot pays that in full.
      // The caller can still widen it, but there is no reason to by default.
      views: options.views ?? [request.rel],
    })
  } catch (err) {
    /* c8 ignore next 2 */
    return { status: 'refused', reason: String(err instanceof Error ? err.message : err) }
  }

  try {
    for (const [relation, rows] of Object.entries(facts)) {
      for (const row of rows) session.update(relation, row, 1)
    }
    session.advance()
    return session.resolve(request)
  } finally {
    // The session applies the changes it commits to, which is right for a
    // session and would be a surprise here. Closing discards them; the caller
    // gets the changes as data and applies them where the facts came from.
    session.close()
  }
}
