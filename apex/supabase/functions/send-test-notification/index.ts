// Signed-in users: send a test push to their own devices (Settings > Notifications).
import { handleTestNotification } from '@apex/notifications-server'
import { serve } from '../_shared/deps.ts'

Deno.serve((req) => serve(handleTestNotification, req))
