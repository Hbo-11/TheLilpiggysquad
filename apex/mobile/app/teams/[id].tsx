import { useLocalSearchParams } from 'expo-router'
import { EntityScreen } from '../../src/components/EntityScreen.tsx'

export default function TeamScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <EntityScreen kind="team" id={String(id)} />
}
