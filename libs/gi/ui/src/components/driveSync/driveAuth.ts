import { clearSyncMarkers } from './driveLocalDb'

const CLIENT_ID = process.env['GOOGLE_CLIENT_ID'] ?? ''
// appdata scope = hidden app folder, user can't accidentally delete it
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const ACCESS_TOKEN_KEY = 'drive_access_token'
// Estimated token expiry (ms epoch) from `expires_in` — lets us refresh before a
// request 401s. localStorage only, never in the backup file.
const TOKEN_EXPIRY_KEY = 'drive_token_expiry'
const DRIVE_EMAIL_KEY = 'drive_email'

let accessToken: string | null = localStorage.getItem(ACCESS_TOKEN_KEY)
let tokenExpiry: number | null =
  Number(localStorage.getItem(TOKEN_EXPIRY_KEY)) || null

// accessToken is the single source of truth for auth; subscribers (the provider)
// re-read isSignedIn() on change instead of each mutating React state by hand.
let authListeners: Array<() => void> = []
export function onAuthChange(cb: () => void): () => void {
  authListeners.push(cb)
  return () => (authListeners = authListeners.filter((c) => c !== cb))
}
function emitAuthChange() {
  authListeners.forEach((cb) => cb())
}

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
        emitAuthChange()
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
  clearToken()
  clearSyncMarkers()
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

// Drop the whole auth session (token, expiry, email) so isSignedIn() flips false
// and the UI shows reconnect. Sync markers are kept — data state, not auth.
function clearToken() {
  accessToken = null
  tokenExpiry = null
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRY_KEY)
  localStorage.removeItem(DRIVE_EMAIL_KEY)
  emitAuthChange()
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

export async function driveRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
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
