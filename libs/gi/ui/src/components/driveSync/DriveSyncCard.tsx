import { CardThemed } from '@genshin-optimizer/common/ui'
import AddToDriveIcon from '@mui/icons-material/AddToDrive'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import RestoreIcon from '@mui/icons-material/Restore'
import {
  Box,
  Button,
  CardContent,
  CircularProgress,
  Divider,
  Tooltip,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'
import { useDriveSync } from './DriveSyncProvider'

export function DriveSyncCard() {
  const {
    signedIn,
    status,
    lastSync,
    email,
    signIn,
    signOut,
    backupNow,
    restoreNow,
  } = useDriveSync()
  const loading = status === 'loading'

  return (
    <CardThemed bgt="light">
      <CardContent sx={{ py: 1 }}>
        <Typography variant="subtitle1">Google Drive Sync</Typography>
      </CardContent>
      <Divider />
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography color="text.secondary">
          This optimizer uses the Application Data Directory on your Google Drive
          to save and sync your database across devices. It can only read and
          write the single backup file that this site created.
        </Typography>

        {!signedIn ? (
          <Button
            startIcon={
              loading ? <CircularProgress size={16} /> : <AddToDriveIcon />
            }
            onClick={signIn}
            disabled={loading}
            variant="contained"
            sx={{ alignSelf: 'flex-start' }}
          >
            Sign in with Google Drive
          </Button>
        ) : (
          <>
            {/* Account + status, label/value rows */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                rowGap: 0.75,
              }}
            >
              <InfoRow label="Email">
                <MaskedEmail email={email} />
                <Button
                  startIcon={<AddToDriveIcon />}
                  onClick={signOut}
                  variant="contained"
                  color="secondary"
                  size="small"
                >
                  Sign out
                </Button>
              </InfoRow>

              <InfoRow label="Sync Status">
                <Box
                  component="span"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                >
                  <Typography
                    component="span"
                    fontWeight="bold"
                    sx={(theme) => ({
                      color: lastSync
                        ? theme.palette.success.main
                        : theme.palette.warning.main,
                    })}
                  >
                    {lastSync ? 'Synced' : 'Not backed up'}
                  </Typography>
                  {lastSync ? (
                    <CheckCircleIcon
                      sx={(theme) => ({
                        color: theme.palette.success.main,
                        fontSize: 20,
                      })}
                    />
                  ) : (
                    <CloudOffIcon
                      sx={(theme) => ({
                        color: theme.palette.warning.main,
                        fontSize: 20,
                      })}
                    />
                  )}
                </Box>
              </InfoRow>

              {lastSync && (
                <InfoRow label="Last Backup">
                  <Typography component="span">
                    {lastSync.toLocaleString(undefined, {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </Typography>
                </InfoRow>
              )}
            </Box>

            {/* Primary data actions */}
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                startIcon={<CloudUploadIcon />}
                onClick={backupNow}
                disabled={loading}
                variant="contained"
                color="success"
                sx={{ flex: 1 }}
              >
                Backup
              </Button>
              <Button
                startIcon={<RestoreIcon />}
                onClick={restoreNow}
                disabled={loading}
                variant="contained"
                color="primary"
                sx={{ flex: 1 }}
              >
                Restore
              </Button>
            </Box>
          </>
        )}
      </CardContent>
    </CardThemed>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap' }}
    >
      <Typography fontWeight="bold" sx={{ minWidth: 100, flexShrink: 0 }}>
        {label}:
      </Typography>
      {children}
    </Box>
  )
}

// Email is hidden behind a solid block and revealed on hover, so screenshots /
// screen-shares don't leak the account address.
function MaskedEmail({ email }: { email: string }) {
  if (!email)
    return (
      <Typography component="span" color="text.secondary">
        —
      </Typography>
    )
  return (
    <Tooltip title="Hover to reveal" placement="top" arrow>
      <Box
        component="span"
        sx={(theme) => ({
          position: 'relative',
          display: 'inline-block',
          px: 1,
          py: 0.25,
          borderRadius: 0.5,
          fontWeight: 'bold',
          whiteSpace: 'nowrap',
          cursor: 'default',
          // The real email always reserves the width (so the box never resizes
          // on hover) but is hidden and unselectable — visibility:hidden text
          // can't be selected/copied, so it can't be leaked by highlighting.
          '& .go-email-real': { visibility: 'hidden', userSelect: 'none' },
          // A solid block laid over it, removed on hover to reveal the email.
          '& .go-email-mask': {
            position: 'absolute',
            inset: 0,
            borderRadius: 0.5,
            bgcolor: theme.palette.neutral700.main,
          },
          '&:hover': {
            '& .go-email-real': { visibility: 'visible', userSelect: 'text' },
            '& .go-email-mask': { display: 'none' },
          },
        })}
      >
        <Box component="span" className="go-email-real">
          {email}
        </Box>
        <Box component="span" className="go-email-mask" aria-hidden />
      </Box>
    </Tooltip>
  )
}
