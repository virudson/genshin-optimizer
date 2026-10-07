import { DBLocalStorage, SandboxStorage } from '@genshin-optimizer/common/database'
import { ArtCharDatabase } from '@genshin-optimizer/gi/db'

const LAST_SYNC_KEY = 'drive_last_sync'
// Wall-clock time of the last successful sync, for display. Persisted so the
// status can render immediately on refresh instead of flashing "not synced".
const LAST_SYNC_TIME_KEY = 'drive_last_sync_time'
export const UPDATE_TIME_KEY = 'updateTime'

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
export function recordSync(localLastEdit: number) {
  localStorage.setItem(LAST_SYNC_KEY, localLastEdit.toString())
  localStorage.setItem(LAST_SYNC_TIME_KEY, Date.now().toString())
}

// Sync markers are data-sync state, not auth — only dropped on a full sign-out.
export function clearSyncMarkers() {
  localStorage.removeItem(LAST_SYNC_KEY)
  localStorage.removeItem(LAST_SYNC_TIME_KEY)
}

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

export function buildBackup(): BackupFile {
  return {
    [UPDATE_TIME_KEY]: getLocalLastEdit(),
    slot1: exportSlot(1),
    slot2: exportSlot(2),
    slot3: exportSlot(3),
    slot4: exportSlot(4),
  }
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
export function applyBackup(backup: BackupFile): void {
  const active = getActiveSlot()

  for (const s of [1, 2, 3, 4] as const) {
    // Missing slot in the backup → leave the existing slot untouched rather
    // than overwriting it with an empty database.
    const good = backup[`slot${s}`]
    if (!good) continue
    const sandbox = importSlot(s, good)
    if (s === active) {
      // Replace live GO keys (preserving drive/tab bookkeeping & other slots).
      new DBLocalStorage(localStorage).removeForKeys((k) => !PRESERVED_KEY(k))
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
