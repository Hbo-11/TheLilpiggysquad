import { useLocalSearchParams } from 'expo-router'
import { ModuleDestination } from '../../../src/components/EntityScreen.tsx'

export default function ReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <ModuleDestination title="Report or export" module="Apex AI reports" id={String(id)} />
}
