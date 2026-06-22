import { driveRequest, isSignedIn } from './driveAuth'
import type { BackupFile } from './driveLocalDb'
import {
  applyBackup,
  buildBackup,
  getLocalLastEdit,
  getLocalSize,
  recordSync,
  UPDATE_TIME_KEY,
} from './driveLocalDb'

const BACKUP_FILENAME = 'go-backup.json'
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

export type ConflictData = {
  driveInfo: DriveFileInfo
  driveUpdateTime: number
  localLastEdit: number
  localSize: number
  driveSize: number
  driveIsNewer: boolean
  sizeRatioWarning: boolean // true if one side is < 30% the size of the other
  driveTooLarge: boolean // remote exceeds the size cap — can't be restored
  // The already-downloaded remote backup, so resolving the conflict (restore /
  // download-both) reuses it instead of re-fetching from Drive. null when the
  // remote was never downloaded (too large).
  driveBackup: BackupFile | null
}

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

function buildConflictData(
  driveInfo: DriveFileInfo,
  driveUpdateTime: number,
  localLastEdit: number,
  driveBackup: BackupFile | null
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
    driveBackup,
  }
}

export async function uploadToDrive(): Promise<void> {
  if (!isSignedIn()) throw new Error('Not signed in')

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
  if (!isSignedIn()) throw new Error('Not signed in')

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
    return { type: 'conflict', data: buildConflictData(driveInfo, 0, localLastEdit, null) }

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
  return {
    type: 'conflict',
    data: buildConflictData(driveInfo, driveUpdateTime, localLastEdit, backup),
  }
}

// Explicit "Restore" action: compare and surface a conflict, or null if in sync.
export async function checkConflict(): Promise<ConflictData | null> {
  if (!isSignedIn()) throw new Error('Not signed in')

  const driveInfo = await findBackupFile()
  if (!driveInfo) return null

  if (driveInfo.size > MAX_BACKUP_SIZE)
    return buildConflictData(driveInfo, 0, getLocalLastEdit(), null)

  const backup = await downloadBackup(driveInfo)
  const driveUpdateTime = backup[UPDATE_TIME_KEY] ?? 0
  const localLastEdit = getLocalLastEdit()

  // Exact timestamp match = same data, nothing to resolve.
  if (driveUpdateTime === localLastEdit) return null

  return buildConflictData(driveInfo, driveUpdateTime, localLastEdit, backup)
}

// Pass the backup already downloaded for the conflict prompt to skip a re-fetch.
export async function restoreFromDrive(backup?: BackupFile): Promise<void> {
  if (!isSignedIn()) throw new Error('Not signed in')

  if (!backup) {
    const driveInfo = await findBackupFile()
    if (!driveInfo) throw new Error('No backup found in Google Drive')
    if (driveInfo.size > MAX_BACKUP_SIZE)
      throw new Error('Backup file too large — possibly corrupted')
    backup = await downloadBackup(driveInfo)
  }
  applyBackup(backup)
}

export async function deleteBackupFromDrive(): Promise<void> {
  if (!isSignedIn()) throw new Error('Not signed in')
  const existing = await findBackupFile()
  if (!existing) return
  const res = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${existing.id}`,
    { method: 'DELETE' }
  )
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed: ${res.statusText}`)
}

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
// is ever lost no matter which version the user picks. Reuses the backup already
// downloaded for the conflict prompt; only re-fetches when called without one.
export async function downloadBothBackups(driveBackup?: BackupFile | null): Promise<void> {
  downloadJson(JSON.stringify(buildBackup()), 'go-local-backup')
  if (!driveBackup) {
    const driveInfo = await findBackupFile()
    if (driveInfo && driveInfo.size <= MAX_BACKUP_SIZE)
      driveBackup = await downloadBackup(driveInfo)
  }
  if (driveBackup) downloadJson(JSON.stringify(driveBackup), 'go-drive-backup')
}
