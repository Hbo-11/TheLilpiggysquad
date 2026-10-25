// Webhook for trusted motorsport data providers (HMAC-signed; see docs/NOTIFICATIONS.md).
import { handleIngest } from '@apex/notifications-server'
import { serve } from '../_shared/deps.ts'

Deno.serve((req) => serve(handleIngest, req))
