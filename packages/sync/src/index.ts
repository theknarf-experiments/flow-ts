// @flow-ts/sync — generic, transport-agnostic sync engine for
// flow-ts EDB row sets. Built on Merkle Search Trees over bab-hashed
// content-addressed payloads. The caller brings its own transport
// (WebSocket, WebRTC, …) and wires the engine into its local Store.

export { SyncEngine, type SyncEngineOptions, type PeerHandle, type RemoteAddListener } from './engine.js'
export { babHash, babEncode, babDecode, type Hash } from './bab/index.js'
export { Mst, type MstNode, diff, type DiffResult } from './mst/index.js'
export type { Transport, InterferenceKnobs, Unsubscribe } from './transport/index.js'
export { inMemoryPair, withInterference, makeRng } from './transport/index.js'
