// Cron (every minute): process queued jobs, scan for due session reminders, send due pushes.
import { handleProcess } from '@apex/notifications-server'
import { serve } from '../_shared/deps.ts'

Deno.serve((req) => serve(handleProcess, req))
