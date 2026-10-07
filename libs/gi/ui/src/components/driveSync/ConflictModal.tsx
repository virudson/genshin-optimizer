import CloudIcon from '@mui/icons-material/Cloud'
import ComputerIcon from '@mui/icons-material/Computer'
import DownloadIcon from '@mui/icons-material/Download'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  Divider,
  Paper,
  Typography,
} from '@mui/material'
import WarningIcon from '@mui/icons-material/Warning'
import type { ConflictData } from './driveApi'

type Props = {
  open: boolean
  data: ConflictData | null
  onUseDrive: () => void
  onUseLocal: () => void
  onDownloadBackups: () => void
}

function formatSize(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatDate(ts: number | string) {
  return new Date(ts).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ConflictModal({
  open,
  data,
  onUseDrive,
  onUseLocal,
  onDownloadBackups,
}: Props) {
  if (!data) return null

  return (
    // Forced choice: no backdrop-close, no Escape — the only way out is to pick
    // a side, so the conflict can't be left silently unresolved.
    <Dialog open={open} disableEscapeKeyDown maxWidth="xs" fullWidth>
      <DialogContent
        sx={(theme) => ({
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          p: 3,
          bgcolor: theme.palette.neutral800.main,
        })}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
          <WarningAmberIcon
            sx={(theme) => ({ fontSize: 36, color: theme.palette.warning.main, flexShrink: 0, mt: 0.3 })}
          />
          <Typography variant="subtitle1" fontWeight="bold">
            Your local data in this browser is conflicting with the one stored in Google Drive!
          </Typography>
        </Box>

        {data.sizeRatioWarning && (
          <Box sx={(theme) => ({ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, borderRadius: 1, bgcolor: theme.palette.warning.dark, color: theme.palette.warning.contrastText })}>
            <WarningIcon fontSize="small" />
            <Typography variant="body2" fontWeight="bold">
              Warning: One version is significantly smaller than the other. It may be empty or corrupted. Be careful which one you choose.
            </Typography>
          </Box>
        )}

        <Paper variant="outlined" sx={(theme) => ({ p: 2, bgcolor: theme.palette.neutral700.main, borderColor: theme.palette.neutral500.main })}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <CloudIcon fontSize="small" />
            <Typography variant="subtitle1" fontWeight="bold">
              Google Drive Data —{' '}
              <Chip label={data.driveIsNewer ? 'NEWER' : 'OLDER'} size="small" color={data.driveIsNewer ? 'success' : 'error'} sx={{ fontWeight: 'bold', fontSize: '0.7rem' }} />
              {' '}— {formatSize(data.driveInfo.size)}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {data.driveTooLarge
              ? 'File is too large — likely corrupted and cannot be restored.'
              : `Last modified: ${formatDate(data.driveUpdateTime)}`}
          </Typography>
          <Button
            fullWidth
            color="primary"
            startIcon={<CloudIcon />}
            onClick={onUseDrive}
            disabled={data.driveTooLarge}
            sx={{ mt: 1.5 }}
          >
            Use Data From Google Drive
          </Button>
        </Paper>

        <Divider sx={(theme) => ({ color: theme.palette.neutral300.main })}>OR</Divider>

        <Paper variant="outlined" sx={(theme) => ({ p: 2, bgcolor: theme.palette.neutral700.main, borderColor: theme.palette.neutral500.main })}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <ComputerIcon fontSize="small" />
            <Typography variant="subtitle1" fontWeight="bold">
              Local Browser Data —{' '}
              <Chip label={!data.driveIsNewer ? 'NEWER' : 'OLDER'} size="small" color={!data.driveIsNewer ? 'success' : 'error'} sx={{ fontWeight: 'bold', fontSize: '0.7rem' }} />
              {' '}— {formatSize(data.localSize)}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            Last modified: {formatDate(data.localLastEdit)}
          </Typography>
          <Button fullWidth color="secondary" startIcon={<ComputerIcon />} onClick={onUseLocal} sx={{ mt: 1.5 }}>
            Use Local Browser Data
          </Button>
        </Paper>

        <Button
          fullWidth
          variant="text"
          startIcon={<DownloadIcon />}
          onClick={onDownloadBackups}
        >
          Download both backups first
        </Button>
      </DialogContent>
    </Dialog>
  )
}
