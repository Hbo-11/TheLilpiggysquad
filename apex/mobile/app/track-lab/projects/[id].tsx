import { useLocalSearchParams } from 'expo-router'
import { ModuleDestination } from '../../../src/components/EntityScreen.tsx'

export default function TrackProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <ModuleDestination title="Track Lab project" module="Track Lab" id={String(id)} />
}
