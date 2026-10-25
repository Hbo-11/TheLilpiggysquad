import { isSafeExternalUrl } from '@apex/notifications-core'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { Badge, Button, EmptyState, Loading, Screen } from '../../src/components/ui.tsx'
import { getArticle, type ArticleRow } from '../../src/data/motorsport.ts'
import { backendConfigured } from '../../src/lib/backend.ts'
import { stamp } from '../../src/lib/format.ts'
import { useNotifications } from '../../src/notifications/NotificationsProvider.tsx'
import { spacing, type } from '../../src/theme.ts'

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Article destination. Shows the source and links to it; only confirmed items are ever notified. */
export default function ArticleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { timeZone } = useNotifications()
  const [article, setArticle] = useState<ArticleRow | null | undefined>(undefined)

  useEffect(() => {
    if (!VALID_ID.test(String(id))) return setArticle(null)
    getArticle(String(id)).then(setArticle).catch(() => setArticle(null))
  }, [id])

  if (!backendConfigured) {
    return (
      <Screen>
        <EmptyState icon="newspaper-outline" title="News isn't connected" body="This build has no Apex AI server, so articles are unavailable." />
      </Screen>
    )
  }
  if (article === undefined) return <Loading label="Loading article" />
  if (article === null) {
    return (
      <Screen>
        <EmptyState icon="help-circle-outline" title="Article not found" body="It may have been withdrawn by the source." />
      </Screen>
    )
  }
  return (
    <Screen>
      <Stack.Screen options={{ title: article.kind === 'announcement' ? 'Announcement' : 'News' }} />
      <View style={styles.meta}>
        {article.verification === 'confirmed' ? <Badge text="CONFIRMED" tone="success" /> : <Badge text="NOT CONFIRMED" tone="warning" />}
        <Text style={type.tiny}>{stamp(article.published_at, timeZone)}</Text>
      </View>
      <Text style={type.title}>{article.headline}</Text>
      <Text style={type.body}>{article.summary}</Text>
      <Text style={type.small}>Source: {article.data_sources?.name ?? 'Unknown'}</Text>
      {isSafeExternalUrl(article.url) ? <Button label="Read the full story at the source" variant="secondary" icon="open-outline" onPress={() => void Linking.openURL(article.url!)} /> : null}
    </Screen>
  )
}

const styles = StyleSheet.create({ meta: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' } })
