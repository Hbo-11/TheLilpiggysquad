// Called by other Apex AI backend services when an AI or Track Lab job finishes or fails.
import { handleAppEvent } from '@apex/notifications-server'
import { serve } from '../_shared/deps.ts'

Deno.serve((req) => serve(handleAppEvent, req))
