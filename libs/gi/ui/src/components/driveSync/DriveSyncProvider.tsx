import { Alert, Snackbar } from '@mui/material'
import type { ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import { ConflictModal } from './ConflictModal'
import type { ConflictData } from './driveApi'
import {
  checkConflict,
  downloadBothBackups,
  getDriveEmail,
  getLastSyncTime,
  initialSync,
  isSignedIn,
  restoreFromDrive,
  signIn,
  signOut,
  uploadToDrive,
} from './driveApi'

type Status = 'idle' | 'loading' | 'success' | 'error'

export type DriveSyncContextValue = {
  signedIn: boolean
  status: Status
  lastSync: Date | null
  email: string
  signIn: () => Promise<void>
  signOut: () => void
  backupNow: () => Promise<void>
  restoreNow: () => Promise<void>
}

const DriveSyncContext = createContext<DriveSyncContextValue | null>(null)

export function useDriveSync(): DriveSyncContextValue {
  const ctx = useContext(DriveSyncContext)
  if (!ctx)
    throw new Error('useDriveSync must be used within a DriveSyncProvider')
  return ctx
}

/**
 * App-wide Google Drive sync state. Mount once near the app root so the conflict
 * modal and status can surface on any page, not only while the settings card is
 * mounted. The only automatic step is a one-time conflict check on first
 * sign-in; everything after is manual — Backup uploads, Restore pulls (with a
 * conflict prompt), Delete removes the remote file. There is no auto-sync loop.
 */
export function DriveSyncProvider({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(isSignedIn())
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [severity, setSeverity] = useState<'success' | 'error'>('success')
  const [conflict, setConflict] = useState<ConflictData | null>(null)
  // Hydrate from the persisted sync time so a refresh shows "synced" right away
  // instead of flashing "not synced" until initialSync resolves.
  const [lastSync, setLastSync] = useState<Date | null>(() =>
    isSignedIn() ? getLastSyncTime() : null
  )
  const [email, setEmail] = useState('')
  const [initialCheckDone, setInitialCheckDone] = useState(false)

  // Fetch the connected account's email for display.
  useEffect(() => {
    if (!signedIn) {
      setEmail('')
      return
    }
    let cancelled = false
    getDriveEmail().then((e) => {
      if (!cancelled) setEmail(e)
    })
    return () => {
      cancelled = true
    }
  }, [signedIn])

  useEffect(() => {
    if (status === 'success' || status === 'error') setSeverity(status)
  }, [status])

  // On first sign-in only: reconcile with Drive once. Surfaces the conflict
  // modal if local and remote diverge, seeds the remote on first use, or pulls
  // into an empty local DB. After this it's fully manual — no auto-sync loop.
  useEffect(() => {
    if (!signedIn || initialCheckDone) return

    async function initialCheck() {
      try {
        const result = await initialSync()
        if (result.type === 'conflict') {
          setConflict(result.data)
        } else if (result.type === 'restored') {
          // Pulled remote into an empty local DB — reload to load it into memory.
          setStatus('success')
          setMessage('Restored from Google Drive — reloading...')
          setTimeout(() => window.location.reload(), 1500)
        } else if (result.type === 'empty') {
          // Nothing on Drive and nothing local — leave status as not-backed-up.
        } else {
          setLastSync(new Date())
        }
      } catch {
        // network/permission error — leave unsynced, user can retry manually
      } finally {
        setInitialCheckDone(true)
      }
    }

    initialCheck()
  }, [signedIn, initialCheckDone])

  async function handleSignIn() {
    try {
      setStatus('loading')
      await signIn()
      setSignedIn(true)
      setStatus('idle')
    } catch (e: any) {
      setStatus('error')
      setMessage(e.message)
    }
  }

  function handleSignOut() {
    signOut()
    setSignedIn(false)
    setInitialCheckDone(false)
    setLastSync(null)
  }

  async function handleBackupNow() {
    try {
      setStatus('loading')
      await uploadToDrive()
      setLastSync(new Date())
      setStatus('success')
      setMessage('Saved to Google Drive')
    } catch (e: any) {
      setStatus('error')
      setMessage(e.message)
    }
  }

  async function handleRestoreNow() {
    try {
      setStatus('loading')
      const found = await checkConflict()
      if (found) {
        setConflict(found)
        setStatus('idle')
      } else {
        setStatus('success')
        setMessage('Already in sync with Google Drive')
      }
    } catch (e: any) {
      setStatus('error')
      setMessage(e.message)
    }
  }

  async function handleUseDrive() {
    if (!conflict) return
    try {
      await restoreFromDrive()
      setConflict(null)
      setStatus('success')
      setMessage('Restored from Google Drive — reloading...')
      setTimeout(() => window.location.reload(), 1500)
    } catch (e: any) {
      setStatus('error')
      setMessage(e.message)
    }
  }

  async function handleUseLocal() {
    try {
      await uploadToDrive()
      setLastSync(new Date())
      setConflict(null)
      setStatus('success')
      setMessage('Local data saved to Google Drive')
    } catch (e: any) {
      setStatus('error')
      setMessage(e.message)
    }
  }

  async function handleDownloadBackups() {
    try {
      await downloadBothBackups()
    } catch (e: any) {
      setStatus('error')
      setMessage(e.message)
    }
  }

  const value: DriveSyncContextValue = {
    signedIn,
    status,
    lastSync,
    email,
    signIn: handleSignIn,
    signOut: handleSignOut,
    backupNow: handleBackupNow,
    restoreNow: handleRestoreNow,
  }

  return (
    <DriveSyncContext.Provider value={value}>
      {children}

      <ConflictModal
        open={!!conflict}
        data={conflict}
        onUseDrive={handleUseDrive}
        onUseLocal={handleUseLocal}
        onDownloadBackups={handleDownloadBackups}
      />

      <Snackbar
        open={status === 'success' || status === 'error'}
        autoHideDuration={4000}
        onClose={() => setStatus('idle')}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={severity}
          variant="filled"
          onClose={() => setStatus('idle')}
          sx={{ fontSize: '1rem', alignItems: 'center', '& .MuiAlert-icon': { fontSize: 26 } }}
        >
          {message}
        </Alert>
      </Snackbar>
    </DriveSyncContext.Provider>
  )
}
