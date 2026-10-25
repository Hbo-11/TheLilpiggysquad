import { useLocalSearchParams } from 'expo-router'
import { ModuleDestination } from '../../../src/components/EntityScreen.tsx'

export default function AnalysisScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <ModuleDestination title="Saved analysis" module="Apex AI analysis" id={String(id)} />
}
