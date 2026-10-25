import { useLocalSearchParams } from 'expo-router'
import { EntityScreen } from '../../src/components/EntityScreen.tsx'

export default function DriverScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <EntityScreen kind="driver" id={String(id)} />
}
