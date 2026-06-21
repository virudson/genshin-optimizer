import { DBLocalStorage, SandboxStorage } from '@genshin-optimizer/common/database'
import { ArtCharDatabase } from '@genshin-optimizer/gi/db'

const CLIENT_ID = process.env['GOOGLE_CLIENT_ID'] ?? ''
// appdata scope = hidden app folder, user can't accidentally delete it
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const ACCESS_TOKEN_KEY = 'drive_access_token'
// Estimated token expiry (ms epoch) from `expires_in` — lets us refresh before a
// request 401s. localStorage only, never in the backup file.
const TOKEN_EXPIRY_KEY = 'drive_token_expiry'
const DRIVE_EMAIL_KEY = 'drive_email'
const LAST_SYNC_KEY = 'drive_last_sync'
// Wall-clock time of the last successful sync, for display. Persisted so the
// status can render immediately on refresh instead of flashing "not synced".
const LAST_SYNC_TIME_KEY = 'drive_last_sync_time'
const BACKUP_FILENAME = 'go-backup.json'
const UPDATE_TIME_KEY = 'updateTime'
// A real backup is well under 1 MB. Anything past this is almost certainly
// corrupt, so we refuse to download it and treat the remote as unusable.
const MAX_BACKUP_SIZE = 50 * 1024 * 1024

// Result of the on-sign-in reconciliation between local and Drive data.
export type SyncResult =
  | { type: 'conflict'; data: ConflictData } // timestamps diverge — user must choose
  | { type: 'uploaded' } // no remote backup existed — pushed local up
  | { type: 'restored' } // no local data — pulled remote down (caller should reload)
  | { type: 'synced' } // timestamps match — nothing to do
  | { type: 'empty' } // nothing locally and nothing on Drive — nothing to report

export type DriveFileInfo = {
  id: string
  size: number
}

// Each slot is a full GOOD export — the same format the upload/import UI uses,
// so restoring runs it back through importGOOD (migrations, dedup, equip checks)
// instead of blindly dumping raw localStorage entries.
type GoodSlot = ReturnType<ArtCharDatabase['exportGOOD']>

export type BackupFile = {
  [UPDATE_TIME_KEY]: number // local lastEdit timestamp stored IN the file
  slot1: GoodSlot
  slot2: GoodSlot
  slot3: GoodSlot
  slot4: GoodSlot
}

export type ConflictData = {
  driveInfo: DriveFileInfo
  driveUpdateTime: number
  localLastEdit: number
  localSize: number
  driveSize: number
  driveIsNewer: boolean
  sizeRatioWarning: boolean // true if one side is < 30% the size of the other
  driveTooLarge: boolean // remote exceeds the size cap — can't be restored
}

let accessToken: string | null = localStorage.getItem(ACCESS_TOKEN_KEY)
let tokenExpiry: number | null =
  Number(localStorage.getItem(TOKEN_EXPIRY_KEY)) || null

// ─── Auth ────────────────────────────────────────────────────────────────────

function loadGsiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById('gsi-script')) return resolve()
    const script = document.createElement('script')
    script.id = 'gsi-script'
    script.src = 'https://accounts.google.com/gsi/client'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(script)
  })
}

export async function signIn(silent = false): Promise<void> {
  await loadGsiScript()
  return new Promise((resolve, reject) => {
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      prompt: silent ? 'none' : '',
      callback: (response: any) => {
        if (response.error) return reject(new Error(response.error))
        accessToken = response.access_token
        localStorage.setItem(ACCESS_TOKEN_KEY, accessToken!)
        // Stamp absolute expiry from `expires_in` (seconds) for isTokenExpired().
        const expiresIn = Number(response.expires_in)
        if (expiresIn > 0) {
          tokenExpiry = Date.now() + expiresIn * 1000
          localStorage.setItem(TOKEN_EXPIRY_KEY, tokenExpiry.toString())
        }
        resolve()
      },
      // `callback` only fires on success; a blocked silent-refresh popup lands
      // here. Reject instead of hanging so the caller can drop to signed-out.
      error_callback: (err: any) =>
        reject(new Error(err?.type ?? 'Token request failed')),
    })
    client.requestAccessToken()
  })
}

export function signOut() {
  if (accessToken)
    (window as any).google?.accounts.oauth2.revoke(accessToken)
  // revoke + drop auth session, then the sync markers (kept on a plain expiry).
  clearToken()
  localStorage.removeItem(LAST_SYNC_KEY)
  localStorage.removeItem(LAST_SYNC_TIME_KEY)
}

export function isSignedIn() {
  return !!accessToken
}

// Buffer so we refresh just before expiry; unknown expiry → treat as expired.
function isTokenExpired(bufferMs = 60_000): boolean {
  return !tokenExpiry || Date.now() >= tokenExpiry - bufferMs
}

// Refresh a stale token; throws if it can't renew so the caller can sign out.
export async function ensureFreshToken(): Promise<void> {
  if (!accessToken) return
  if (!isTokenExpired()) return
  await silentRefresh()
}

// The displayable time of the last successful sync, or null if never synced.
// Falls back to the sync marker (a lastEdit ms timestamp) so devices that
// synced before the wall-clock key existed still show as synced on refresh.
export function getLastSyncTime(): Date | null {
  const t =
    localStorage.getItem(LAST_SYNC_TIME_KEY) ?? localStorage.getItem(LAST_SYNC_KEY)
  return t ? new Date(parseInt(t)) : null
}

// Mark this device as synced at localLastEdit, and stamp the wall-clock time
// so the UI can show "last backup" immediately after a refresh.
function recordSync(localLastEdit: number) {
  localStorage.setItem(LAST_SYNC_KEY, localLastEdit.toString())
  localStorage.setItem(LAST_SYNC_TIME_KEY, Date.now().toString())
}

// Last known account email, read synchronously so the UI can show it on load
// without waiting for (or being blanked by) a failing live fetch.
export function getCachedDriveEmail(): string {
  return localStorage.getItem(DRIVE_EMAIL_KEY) ?? ''
}

// The signed-in account's email via the Drive `about` endpoint (no extra
// profile/email scope needed). Caches on success; on any failure (expired
// token, blocked silent refresh, etc.) falls back to the cached value so the
// displayed email never blanks out on revisit.
export async function getDriveEmail(): Promise<string> {
  if (!accessToken) return getCachedDriveEmail()
  try {
    const res = await driveRequest(
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)'
    )
    if (res.ok) {
      const data = await res.json()
      const email = data.user?.emailAddress
      if (email) {
        localStorage.setItem(DRIVE_EMAIL_KEY, email)
        return email
      }
    }
  } catch {
    // fall through to cached
  }
  return getCachedDriveEmail()
}

// ─── Drive Requests ──────────────────────────────────────────────────────────

// Drop the whole auth session (token, expiry, email) so isSignedIn() flips false
// and the UI shows reconnect. Sync markers are kept — data state, not auth.
function clearToken() {
  accessToken = null
  tokenExpiry = null
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRY_KEY)
  localStorage.removeItem(DRIVE_EMAIL_KEY)
}

// Concurrent 401s (e.g. the email fetch and initialSync on mount) must not each
// kick off their own silent token refresh — they'd race and one would fail.
// Share a single in-flight refresh; if it can't renew, the token is unusable.
let refreshing: Promise<void> | null = null
function silentRefresh(): Promise<void> {
  if (!refreshing)
    refreshing = signIn(true)
      .catch((e) => {
        clearToken()
        throw e
      })
      .finally(() => (refreshing = null))
  return refreshing
}

async function driveRequest(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 401) {
    await silentRefresh()
    return fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
    })
  }
  return res
}

// ─── Local Data ──────────────────────────────────────────────────────────────

// Keys that aren't part of any single slot's GO database and must survive a
// restore: the other slots' blobs, the drive tokens, and tab/sync bookkeeping.
const PRESERVED_KEY = (key: string) =>
  key.startsWith('extraDatabase_') ||
  key.startsWith('drive_') ||
  key === 'GONewTabDetection' ||
  key === LAST_SYNC_KEY

type SlotNum = 1 | 2 | 3 | 4

function getActiveSlot(): SlotNum {
  return new DBLocalStorage(localStorage).getDBIndex()
}

// Load a slot's storage into a detached SandboxStorage without touching the
// live DB. Active slot lives in localStorage; the others are extraDatabase_N.
function loadSlotStorage(slotNum: SlotNum): SandboxStorage {
  const sandbox = new SandboxStorage()
  if (slotNum === getActiveSlot()) {
    sandbox.copyFrom(new DBLocalStorage(localStorage))
  } else {
    try {
      const obj = JSON.parse(localStorage.getItem(`extraDatabase_${slotNum}`) ?? '{}')
      for (const [k, v] of Object.entries(obj)) sandbox.setString(k, v as string)
    } catch {
      // empty/corrupt extra slot — leave the sandbox empty
    }
  }
  return sandbox
}

function exportSlot(slotNum: SlotNum): GoodSlot {
  return new ArtCharDatabase(slotNum, loadSlotStorage(slotNum)).exportGOOD()
}

function slotLastEdit(slotNum: SlotNum, active: SlotNum): number {
  try {
    if (slotNum === active)
      return JSON.parse(localStorage.getItem('dbMeta') ?? '{}').lastEdit ?? 0
    const obj = JSON.parse(localStorage.getItem(`extraDatabase_${slotNum}`) ?? '{}')
    return obj.dbMeta ? JSON.parse(obj.dbMeta).lastEdit ?? 0 : 0
  } catch {
    return 0
  }
}

// Most recent edit across ALL slots — the conflict clock. Taking the max (not
// just the active slot) means an edit to an inactive slot still moves the
// timestamp, so it can't silently diverge from Drive.
export function getLocalLastEdit(): number {
  const active = getActiveSlot()
  return Math.max(...([1, 2, 3, 4] as const).map((s) => slotLastEdit(s, active)))
}

export function getLocalSize(): number {
  return new Blob([JSON.stringify(buildBackup())]).size
}

function buildBackup(): BackupFile {
  return {
    [UPDATE_TIME_KEY]: getLocalLastEdit(),
    slot1: exportSlot(1),
    slot2: exportSlot(2),
    slot3: exportSlot(3),
    slot4: exportSlot(4),
  }
}

// ─── Drive File ──────────────────────────────────────────────────────────────

async function findBackupFile(): Promise<DriveFileInfo | null> {
  const res = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${BACKUP_FILENAME}'&fields=files(id,size)`
  )
  const data = await res.json()
  const file = data.files?.[0]
  if (!file) return null
  return { id: file.id, size: parseInt(file.size ?? '0') }
}

async function downloadBackup(driveInfo: DriveFileInfo): Promise<BackupFile> {
  const res = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${driveInfo.id}?alt=media`
  )
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`)
  return res.json()
}

// Import one slot's GOOD into a detached database so migrations, dedup, and
// equip checks run — exactly like the upload UI — then return its storage.
function importSlot(slotNum: SlotNum, good: GoodSlot): SandboxStorage {
  const sandbox = new SandboxStorage()
  const db = new ArtCharDatabase(slotNum, sandbox)
  // keepNotInImport=false so the slot becomes exactly the backup's contents.
  db.importGOOD(good, false, false)
  // importGOOD deliberately drops dbMeta.lastEdit, and importing entities bumps
  // it to Date.now(). Restore the slot's original edit time so the next sign-in
  // compares timestamps correctly instead of seeing a false conflict.
  const lastEdit = (good['dbMeta'] as { lastEdit?: number } | undefined)?.lastEdit ?? 0
  db.dbMeta.set({ lastEdit })
  db.saveStorage()
  return sandbox
}

// Overwrite every slot from a downloaded backup. Each slot is imported (not raw
// copied); the active slot is written to live keys, the others to their
// extraDatabase_ blobs. Caller must reload so App re-reads the live DB.
function applyBackup(backup: BackupFile): void {
  const active = getActiveSlot()

  for (const s of [1, 2, 3, 4] as const) {
    // Missing slot in the backup → leave the existing slot untouched rather
    // than overwriting it with an empty database.
    const good = backup[`slot${s}`]
    if (!good) continue
    const sandbox = importSlot(s, good)
    if (s === active) {
      // Replace live GO keys (preserving drive/tab bookkeeping & other slots).
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        if (!PRESERVED_KEY(key)) toRemove.push(key)
      }
      toRemove.forEach((k) => localStorage.removeItem(k))
      for (const [key, value] of sandbox.entries) localStorage.setItem(key, value)
    } else {
      localStorage.setItem(
        `extraDatabase_${s}`,
        JSON.stringify(Object.fromEntries(sandbox.entries))
      )
    }
  }

  // We are now exactly the backup. Mark this device synced at the backup's
  // edit time so a subsequent sign-in sees "synced" rather than a false conflict.
  recordSync(backup[UPDATE_TIME_KEY])
}

function buildConflictData(
  driveInfo: DriveFileInfo,
  driveUpdateTime: number,
  localLastEdit: number
): ConflictData {
  const localSize = getLocalSize()
  const sizeRatio = Math.min(localSize, driveInfo.size) / Math.max(localSize, driveInfo.size)
  return {
    driveInfo,
    driveUpdateTime,
    localLastEdit,
    localSize,
    driveSize: driveInfo.size,
    driveIsNewer: driveUpdateTime > localLastEdit,
    sizeRatioWarning: sizeRatio < 0.3, // one side is less than 30% of the other
    driveTooLarge: driveInfo.size > MAX_BACKUP_SIZE,
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function uploadToDrive(): Promise<void> {
  if (!accessToken) throw new Error('Not signed in')

  const localLastEdit = getLocalLastEdit()
  if (localLastEdit === 0) throw new Error('No local data to back up')

  const backup = buildBackup()
  const content = JSON.stringify(backup)
  const existing = await findBackupFile()
  const blob = new Blob([content], { type: 'application/json' })
  const metadata = {
    name: BACKUP_FILENAME,
    mimeType: 'application/json',
    ...(existing ? {} : { parents: ['appDataFolder'] }),
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', blob)

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'

  const res = await driveRequest(url, { method: existing ? 'PATCH' : 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`)

  // Record last sync time so we know this device is up to date
  recordSync(localLastEdit)
}

// Reconcile local data with Drive on sign-in. This is the single source of
// truth for the "what should happen now" decision — never short-circuit it
// with drive_last_sync, which only knows when THIS device last uploaded and
// says nothing about what another device may have pushed since.
export async function initialSync(): Promise<SyncResult> {
  if (!accessToken) throw new Error('Not signed in')

  const driveInfo = await findBackupFile()
  const localLastEdit = getLocalLastEdit()

  // No remote backup yet → seed it from local, or report empty if there's
  // nothing to seed (so the UI doesn't claim "synced" with no data anywhere).
  if (!driveInfo) {
    if (localLastEdit === 0) return { type: 'empty' }
    await uploadToDrive()
    return { type: 'uploaded' }
  }

  // Suspiciously large remote → don't download it; let the user decide with a
  // conflict prompt that flags local as the safe choice.
  if (driveInfo.size > MAX_BACKUP_SIZE)
    return { type: 'conflict', data: buildConflictData(driveInfo, 0, localLastEdit) }

  const backup = await downloadBackup(driveInfo)
  const driveUpdateTime = backup[UPDATE_TIME_KEY] ?? 0

  // No local data → just pull the remote down. Caller reloads to pick it up.
  if (localLastEdit === 0) {
    applyBackup(backup)
    return { type: 'restored' }
  }

  // Timestamps agree → already in sync.
  if (driveUpdateTime === localLastEdit) {
    recordSync(localLastEdit)
    return { type: 'synced' }
  }

  // Anything else is a genuine divergence — the user picks a winner.
  return { type: 'conflict', data: buildConflictData(driveInfo, driveUpdateTime, localLastEdit) }
}

// Explicit "Restore" action: compare and surface a conflict, or null if in sync.
export async function checkConflict(): Promise<ConflictData | null> {
  if (!accessToken) throw new Error('Not signed in')

  const driveInfo = await findBackupFile()
  if (!driveInfo) return null

  if (driveInfo.size > MAX_BACKUP_SIZE)
    return buildConflictData(driveInfo, 0, getLocalLastEdit())

  const backup = await downloadBackup(driveInfo)
  const driveUpdateTime = backup[UPDATE_TIME_KEY] ?? 0
  const localLastEdit = getLocalLastEdit()

  // Exact timestamp match = same data, nothing to resolve.
  if (driveUpdateTime === localLastEdit) return null

  return buildConflictData(driveInfo, driveUpdateTime, localLastEdit)
}

export async function restoreFromDrive(): Promise<void> {
  if (!accessToken) throw new Error('Not signed in')

  const driveInfo = await findBackupFile()
  if (!driveInfo) throw new Error('No backup found in Google Drive')
  if (driveInfo.size > MAX_BACKUP_SIZE)
    throw new Error('Backup file too large — possibly corrupted')

  const backup = await downloadBackup(driveInfo)
  applyBackup(backup)
}

export async function deleteBackupFromDrive(): Promise<void> {
  if (!accessToken) throw new Error('Not signed in')
  const existing = await findBackupFile()
  if (!existing) return
  const res = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${existing.id}`,
    { method: 'DELETE' }
  )
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed: ${res.statusText}`)
}

// ─── Backup Export ─────────────────────────────────────────────────────────────

function downloadJson(data: string, name: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Save both sides to disk before a destructive conflict resolution, so nothing
// is ever lost no matter which version the user picks.
export async function downloadBothBackups(): Promise<void> {
  downloadJson(JSON.stringify(buildBackup()), 'go-local-backup')
  const driveInfo = await findBackupFile()
  if (driveInfo && driveInfo.size <= MAX_BACKUP_SIZE) {
    const backup = await downloadBackup(driveInfo)
    downloadJson(JSON.stringify(backup), 'go-drive-backup')
  }
}
