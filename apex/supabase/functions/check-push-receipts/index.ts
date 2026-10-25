// Cron (every 15 minutes): read Expo push receipts, record failures, remove invalid tokens.
import { handleReceipts } from '@apex/notifications-server'
import { serve } from '../_shared/deps.ts'

Deno.serve((req) => serve(handleReceipts, req))
