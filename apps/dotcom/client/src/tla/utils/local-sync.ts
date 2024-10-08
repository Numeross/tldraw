import { assert, getFromLocalStorage, setInLocalStorage } from '@tldraw/utils'
import { IDBPDatabase, openDB } from 'idb'
import {
	RecordType,
	RecordsDiff,
	SerializedSchema,
	SerializedStore,
	Store,
	StoreSchema,
	TAB_ID,
	TLSessionStateSnapshot,
	UnknownRecord,
	squashRecordDiffs,
	transact,
} from 'tldraw'
import { TLA_VERSION } from './tla-version'

const STORE_PREFIX = `TLDRAW_APP_ASSET_STORE_${TLA_VERSION}`

const DB_NAME_INDEX_KEY = `TLDRAW_APP_DB_NAME_INDEX_${TLA_VERSION}`

/** How should we debounce persists? */
const PERSIST_THROTTLE_MS = 350
/** If we're in an error state, how long should we wait before retrying a write? */
const PERSIST_RETRY_THROTTLE_MS = 10_000

const UPDATE_INSTANCE_STATE = Symbol('UPDATE_INSTANCE_STATE')

/** @internal */
export type StoreRecord<S extends Store<any>> = S extends Store<infer R> ? R : never

/**
 * IMPORTANT!!!
 *
 * This is just a quick-n-dirty temporary solution that will be replaced with the remote sync client
 * once it has the db integrated
 */

interface SyncMessage {
	type: 'diff'
	storeId: string
	changes: RecordsDiff<UnknownRecord>
	schema: SerializedSchema
}

// Sent by new clients when they connect
// If another client is on the channel with a newer schema version
// It will
interface AnnounceMessage {
	type: 'announce'
	schema: SerializedSchema
}

type Message = SyncMessage | AnnounceMessage

type UnpackPromise<T> = T extends Promise<infer U> ? U : T

const msg = (msg: Message) => msg

/** @internal */
export class BroadcastChannelMock {
	onmessage?: (e: MessageEvent) => void
	constructor(_name: string) {
		// noop
	}
	postMessage(_msg: Message) {
		// noop
	}
	close() {
		// noop
	}
}

const BC = typeof BroadcastChannel === 'undefined' ? BroadcastChannelMock : BroadcastChannel

/** @internal */
export class LocalSyncClient<T extends UnknownRecord> {
	private disposables = new Set<() => void>()
	private diffQueue: Array<RecordsDiff<T> | typeof UPDATE_INSTANCE_STATE> = []
	private didDispose = false
	private shouldDoFullDBWrite = true
	private isReloading = false
	readonly persistenceKey: string
	readonly sessionId: string
	readonly serializedSchema: SerializedSchema
	private isDebugging = false
	private readonly documentTypes: ReadonlySet<string>

	initTime = Date.now()
	private debug(...args: any[]) {
		if (this.isDebugging) {
			// eslint-disable-next-line no-console
			console.debug(...args)
		}
	}
	constructor(
		public readonly store: Store<T>,
		{
			persistenceKey,
			sessionId = TAB_ID,
			onLoad,
			onLoadError,
		}: {
			persistenceKey: string
			sessionId?: string
			onLoad(self: LocalSyncClient<T>): void
			onLoadError(error: Error): void
		},
		public readonly channel = new BC(`tldraw-tab-sync-${persistenceKey}`)
	) {
		if (typeof window !== 'undefined') {
			;(window as any).tlsync = this
		}
		this.persistenceKey = persistenceKey
		this.sessionId = sessionId

		this.serializedSchema = this.store.schema.serialize()

		this.disposables.add(
			// Set up a subscription to changes from the store: When
			// the store changes (and if the change was made by the user)
			// then immediately send the diff to other tabs via postMessage
			// and schedule a persist.
			store.listen(
				({ changes }) => {
					this.diffQueue.push(changes)
					this.channel.postMessage(
						msg({
							type: 'diff',
							storeId: this.store.id,
							changes,
							schema: this.serializedSchema,
						})
					)
					this.schedulePersist()
				},
				{ source: 'user', scope: 'document' }
			)
		)
		this.disposables.add(
			store.listen(
				() => {
					this.diffQueue.push(UPDATE_INSTANCE_STATE)
					this.schedulePersist()
				},
				{ scope: 'session' }
			)
		)

		this.connect(onLoad, onLoadError)

		this.documentTypes = new Set(
			Object.values(this.store.schema.types as RecordType<T, any>)
				.filter((t) => t.scope === 'document')
				.map((t) => t.typeName)
		)
	}

	private async connect(onLoad: (client: this) => void, onLoadError: (error: Error) => void) {
		this.debug('connecting')
		let data: UnpackPromise<ReturnType<typeof loadDataFromStore>> | undefined

		try {
			data = await loadDataFromStore({
				persistenceKey: this.persistenceKey,
				didCancel: () => this.didDispose,
			})
		} catch (error: any) {
			onLoadError(error)
			showCantReadFromIndexDbAlert()
			if (typeof window !== 'undefined') {
				window.location.reload()
			}
			return
		}

		this.debug('loaded data from store', data, 'didDispose', this.didDispose)
		if (this.didDispose) return

		try {
			if (data) {
				const documentSnapshot = Object.fromEntries(
					data.records.map((r) => [r.id, r])
				) as SerializedStore<T>

				const migrationResult = this.store.schema.migrateStoreSnapshot({
					store: documentSnapshot,
					// eslint-disable-next-line deprecation/deprecation
					schema: data.schema ?? this.store.schema.serializeEarliestVersion(),
				})

				if (migrationResult.type === 'error') {
					console.error('failed to migrate store', migrationResult)
					onLoadError(new Error(`Failed to migrate store: ${migrationResult.reason}`))
					return
				}

				// 3. Merge the changes into the REAL STORE
				this.store.mergeRemoteChanges(() => {
					// Calling put will validate the records!
					this.store.put(
						(Object.values(migrationResult.value) as T[]).filter((r) =>
							this.documentTypes.has(r.typeName)
						),
						'initialize'
					)
				})

				// if (sessionStateSnapshot) {
				// 	loadSessionStateSnapshotIntoStore(this.store, sessionStateSnapshot)
				// }
			}

			this.channel.onmessage = ({ data }) => {
				this.debug('got message', data)
				const msg = data as Message
				// if their schema is earlier than ours, we need to tell them so they can refresh
				// if their schema is later than ours, we need to refresh
				const res = this.store.schema.getMigrationsSince(msg.schema)

				if (!res.ok) {
					// we are older, refresh
					// but add a safety check to make sure we don't get in an infinite loop
					const timeSinceInit = Date.now() - this.initTime
					if (timeSinceInit < 5000) {
						// This tab was just reloaded, but is out of date compared to other tabs.
						// Not expecting this to ever happen. It should only happen if we roll back a release that incremented
						// the schema version (which we should never do)
						// Or maybe during development if you have multiple local tabs open running the app on prod mode and you
						// check out an older commit. Dev server should be fine.
						onLoadError(new Error('Schema mismatch, please close other tabs and reload the page'))
						return
					}
					this.debug('reloading')
					this.isReloading = true
					window?.location?.reload?.()
					return
				} else if (res.value.length > 0) {
					// they are older, tell them to refresh and not write any more data
					this.debug('telling them to reload')
					this.channel.postMessage({ type: 'announce', schema: this.serializedSchema })
					// schedule a full db write in case they wrote data anyway
					this.shouldDoFullDBWrite = true
					this.persistIfNeeded()
					return
				}
				// otherwise, all good, same version :)
				if (msg.type === 'diff') {
					this.debug('applying diff')
					transact(() => {
						this.store.mergeRemoteChanges(() => {
							this.store.applyDiff(msg.changes as any)
							this.store.ensureStoreIsUsable()
						})
					})
				}
			}
			this.channel.postMessage({ type: 'announce', schema: this.serializedSchema })
			this.disposables.add(() => {
				this.channel.close()
			})
			onLoad(this)
		} catch (e: any) {
			this.debug('error loading data from store', e)
			if (this.didDispose) return
			onLoadError(e)
			return
		}
	}

	close() {
		this.debug('closing')
		this.didDispose = true
		this.disposables.forEach((d) => d())
	}

	private isPersisting = false
	private didLastWriteError = false
	private scheduledPersistTimeout: ReturnType<typeof setTimeout> | null = null

	/**
	 * Schedule a persist. Persists don't happen immediately: they are throttled to avoid writing too
	 * often, and will retry if failed.
	 *
	 * @internal
	 */
	private schedulePersist() {
		this.debug('schedulePersist', this.scheduledPersistTimeout)
		if (this.scheduledPersistTimeout) return
		this.scheduledPersistTimeout = setTimeout(
			() => {
				this.scheduledPersistTimeout = null
				this.persistIfNeeded()
			},
			this.didLastWriteError ? PERSIST_RETRY_THROTTLE_MS : PERSIST_THROTTLE_MS
		)
	}

	/**
	 * Persist to IndexedDB only under certain circumstances:
	 *
	 * - If we're not already persisting
	 * - If we're not reloading the page
	 * - And we have something to persist (a full db write scheduled or changes in the diff queue)
	 *
	 * @internal
	 */
	private persistIfNeeded() {
		this.debug('persistIfNeeded', {
			isPersisting: this.isPersisting,
			isReloading: this.isReloading,
			shouldDoFullDBWrite: this.shouldDoFullDBWrite,
			diffQueueLength: this.diffQueue.length,
			storeIsPossiblyCorrupt: this.store.isPossiblyCorrupted(),
		})

		// if we've scheduled a persist for the future, that's no longer needed
		if (this.scheduledPersistTimeout) {
			clearTimeout(this.scheduledPersistTimeout)
			this.scheduledPersistTimeout = null
		}

		// if a persist is already in progress, we don't need to do anything -
		// if there are still outstanding changes once it's finished, it'll
		// schedule another persist
		if (this.isPersisting) return

		// if we're reloading the page, it's because there's a newer client
		// present so lets not overwrite their changes
		if (this.isReloading) return

		// if the store is possibly corrupted, we don't want to persist
		if (this.store.isPossiblyCorrupted()) return

		// if we're scheduled for a full write or if we have changes outstanding, let's persist them!
		if (this.shouldDoFullDBWrite || this.diffQueue.length > 0) {
			this.doPersist()
		}
	}

	/**
	 * Actually persist to IndexedDB. If the write fails, then we'll retry with a full db write after
	 * a short delay.
	 */
	private async doPersist() {
		assert(!this.isPersisting, 'persist already in progress')
		this.isPersisting = true

		this.debug('doPersist start')

		// instantly empty the diff queue, but keep our own copy of it. this way
		// diffs that come in during the persist will still get tracked
		const diffQueue = this.diffQueue
		this.diffQueue = []

		try {
			if (this.shouldDoFullDBWrite) {
				this.shouldDoFullDBWrite = false
				await storeSnapshotInIndexedDb({
					persistenceKey: this.persistenceKey,
					schema: this.store.schema,
					snapshot: this.store.serialize(),
					didCancel: () => this.didDispose,
					// sessionStateSnapshot: this.$sessionStateSnapshot.get(),
				})
			} else {
				const diffs = squashRecordDiffs(
					diffQueue.filter((d): d is RecordsDiff<T> => d !== UPDATE_INSTANCE_STATE)
				)
				await storeChangesInIndexedDb({
					persistenceKey: this.persistenceKey,
					changes: diffs,
					schema: this.store.schema,
					didCancel: () => this.didDispose,
				})
			}
			this.didLastWriteError = false
		} catch (e) {
			// set this.shouldDoFullDBWrite because we clear the diffQueue no matter what,
			// so if this is just a temporary error, we will still persist all changes
			this.shouldDoFullDBWrite = true
			this.didLastWriteError = true
			console.error('failed to store changes in indexed db', e)

			showCantWriteToIndexDbAlert()
			if (typeof window !== 'undefined') {
				// adios
				window.location.reload()
			}
		}

		this.isPersisting = false
		this.debug('doPersist end')

		// changes might have come in between when we started the persist and
		// now. we request another persist so any new changes can get written
		this.schedulePersist()
	}
}

/** @internal */
export function showCantWriteToIndexDbAlert() {
	window.alert(
		`Oops! We could not save changes to your browser's storage. We now need to reload the page and try again.

Keep seeing this message?
• If you're using tldraw in a private or "incognito" window, try loading tldraw in a regular window or in a different browser.
• If your hard disk is full, try clearing up some space and then reload the page.`
	)
}

/** @internal */
export function showCantReadFromIndexDbAlert() {
	window.alert(
		`Oops! We could not access your browser's storage—and the app won't work correctly without that. We now need to reload the page and try again.

Keep seeing this message?
• If you're using tldraw in a private or "incognito" window, try loading tldraw in a regular window or in a different browser.`
	)
}

const Table = {
	Records: 'records',
	Schema: 'schema',
	SessionState: 'session_state',
} as const

type StoreName = (typeof Table)[keyof typeof Table]

interface LoadResult<T extends UnknownRecord = UnknownRecord> {
	records: StoreRecord<Store<T>>[]
	schema?: SerializedSchema
	sessionStateSnapshot?: TLSessionStateSnapshot | null
}

function addDbName(name: string, indexKey = DB_NAME_INDEX_KEY) {
	const all = new Set(getAllIndexDbNames(indexKey))
	all.add(name)
	setInLocalStorage(indexKey, JSON.stringify([...all]))
}

async function withDb<T>(
	storeId: string,
	cb: (db: IDBPDatabase<StoreName>) => Promise<T>,
	indexKey: string
) {
	addDbName(storeId, indexKey)
	const db = await openDB<StoreName>(storeId, 4, {
		upgrade(database) {
			if (!database.objectStoreNames.contains(Table.Records)) {
				database.createObjectStore(Table.Records)
			}
			if (!database.objectStoreNames.contains(Table.Schema)) {
				database.createObjectStore(Table.Schema)
			}
			if (!database.objectStoreNames.contains(Table.SessionState)) {
				database.createObjectStore(Table.SessionState)
			}
		},
	})
	try {
		return await cb(db)
	} finally {
		db.close()
	}
}

async function pruneSessionState({
	storePrefix = STORE_PREFIX,
	indexKey = DB_NAME_INDEX_KEY,
	persistenceKey,
	didCancel,
}: {
	indexKey?: string
	storePrefix?: string
	persistenceKey: string
	didCancel?(): boolean
}) {
	await withDb(
		storePrefix + persistenceKey,
		async (db) => {
			const tx = db.transaction([Table.SessionState], 'readwrite')
			const sessionStateStore = tx.objectStore(Table.SessionState)
			const all = (await sessionStateStore.getAll()).sort((a, b) => a.updatedAt - b.updatedAt)
			if (all.length < 10) {
				await tx.done
				return
			}
			const toDelete = all.slice(0, all.length - 10)
			for (const { id } of toDelete) {
				await sessionStateStore.delete(id)
			}
			if (didCancel?.()) return tx.abort()
			await tx.done
		},
		indexKey
	)
}

/** @internal */
export async function loadDataFromStore<T extends UnknownRecord>({
	storePrefix = STORE_PREFIX,
	indexKey = DB_NAME_INDEX_KEY,
	persistenceKey,
	didCancel,
}: {
	storePrefix?: string
	indexKey?: string
	persistenceKey: string
	didCancel?(): boolean
}): Promise<undefined | LoadResult> {
	const storeId = storePrefix + persistenceKey
	if (!getAllIndexDbNames(indexKey).includes(storeId)) return undefined
	await pruneSessionState({ persistenceKey, didCancel })

	return await withDb(
		storeId,
		async (db) => {
			if (didCancel?.()) return undefined
			const tx = db.transaction([Table.Records, Table.Schema, Table.SessionState], 'readonly')
			const recordsStore = tx.objectStore(Table.Records)
			const schemaStore = tx.objectStore(Table.Schema)
			const result = {
				records: await recordsStore.getAll(),
				schema: await schemaStore.get(Table.Schema),
			} satisfies LoadResult<T>
			if (didCancel?.()) {
				tx.abort()
				return undefined
			}
			await tx.done
			return result
		},
		indexKey
	)
}

/** @internal */
export async function storeChangesInIndexedDb<T extends UnknownRecord>({
	storePrefix = STORE_PREFIX,
	indexKey = DB_NAME_INDEX_KEY,
	persistenceKey,
	schema,
	changes,
	didCancel,
}: {
	storePrefix?: string
	indexKey?: string
	persistenceKey: string
	schema: StoreSchema<T>
	changes: RecordsDiff<UnknownRecord>
	didCancel?(): boolean
}) {
	const storeId = storePrefix + persistenceKey
	await withDb(
		storeId,
		async (db) => {
			const tx = db.transaction([Table.Records, Table.Schema, Table.SessionState], 'readwrite')
			const recordsStore = tx.objectStore(Table.Records)
			const schemaStore = tx.objectStore(Table.Schema)

			for (const [id, record] of Object.entries(changes.added)) {
				await recordsStore.put(record, id)
			}

			for (const [_prev, updated] of Object.values(changes.updated)) {
				await recordsStore.put(updated, updated.id)
			}

			for (const id of Object.keys(changes.removed)) {
				await recordsStore.delete(id)
			}

			schemaStore.put(schema.serialize(), Table.Schema)

			if (didCancel?.()) return tx.abort()

			await tx.done
		},
		indexKey
	)
}

/** @internal */
export async function storeSnapshotInIndexedDb<T extends UnknownRecord>({
	storePrefix = STORE_PREFIX,
	indexKey = DB_NAME_INDEX_KEY,
	persistenceKey,
	schema,
	snapshot,
	didCancel,
}: {
	storePrefix?: string
	indexKey?: string
	persistenceKey: string
	schema: StoreSchema<T>
	snapshot: SerializedStore<T>
	didCancel?(): boolean
}) {
	const storeId = storePrefix + persistenceKey

	await withDb(
		storeId,
		async (db) => {
			const tx = db.transaction([Table.Records, Table.Schema, Table.SessionState], 'readwrite')
			const recordsStore = tx.objectStore(Table.Records)
			const schemaStore = tx.objectStore(Table.Schema)

			await recordsStore.clear()

			for (const [id, record] of Object.entries(snapshot)) {
				await recordsStore.put(record, id)
			}

			schemaStore.put(schema.serialize(), Table.Schema)

			if (didCancel?.()) return tx.abort()

			await tx.done
		},
		indexKey
	)
}

/** @internal */
export function getAllIndexDbNames(indexKey = DB_NAME_INDEX_KEY): string[] {
	const result = JSON.parse(getFromLocalStorage(indexKey) || '[]') ?? []
	if (!Array.isArray(result)) {
		return []
	}
	return result
}

/* ------------------- Thumbnails ------------------- */

const ThumbnailTable = {
	Thumbnails: 'thumbnails',
	Hashes: 'hashes',
} as const

interface ThumbnailLoadResult {
	thumbnail: string | null
	hash: string | null
}

const THUMBNAIL_STORE_ID = 'TL_THUMBNAIL_STORE'

const THUMBNAIL_STORE_VERSION = 5

async function getThumbnailDb() {
	return await openDB(THUMBNAIL_STORE_ID, THUMBNAIL_STORE_VERSION, {
		upgrade(database) {
			if (!database.objectStoreNames.contains(ThumbnailTable.Thumbnails)) {
				database.createObjectStore(ThumbnailTable.Thumbnails)
			}
			if (!database.objectStoreNames.contains(ThumbnailTable.Hashes)) {
				database.createObjectStore(ThumbnailTable.Hashes)
			}
		},
	})
}

/** @internal */
export async function loadThumbnailFromStore({
	fileId,
	didCancel,
}: {
	fileId: string
	didCancel?(): boolean
}): Promise<undefined | ThumbnailLoadResult> {
	const db = await getThumbnailDb()
	if (didCancel?.()) return undefined
	const tx = db.transaction([ThumbnailTable.Thumbnails, ThumbnailTable.Hashes], 'readonly')
	const thumbnailStore = tx.objectStore(ThumbnailTable.Thumbnails)
	const hashesStore = tx.objectStore(ThumbnailTable.Hashes)
	const result = {
		thumbnail: await thumbnailStore.get(fileId),
		hash: await hashesStore.get(fileId),
	} satisfies ThumbnailLoadResult
	if (didCancel?.()) {
		tx.abort()
		return undefined
	}
	await tx.done
	return result
}

/** @internal */
export async function storeThumbnailInIndexedDb({
	fileId,
	hash,
	thumbnail,
	didCancel,
}: {
	fileId: string
	hash: string
	thumbnail: string
	didCancel?(): boolean
}) {
	const db = await getThumbnailDb()
	if (didCancel?.()) return
	const tx = db.transaction([ThumbnailTable.Thumbnails, ThumbnailTable.Hashes], 'readwrite')
	const thumbnailStore = tx.objectStore(ThumbnailTable.Thumbnails)
	await thumbnailStore.put(thumbnail, fileId)
	const hashStore = tx.objectStore(ThumbnailTable.Hashes)
	await hashStore.put(hash, fileId)
	if (didCancel?.()) return tx.abort()
	await tx.done
}
