import type { ExpoConfig } from 'expo/config'

// Public configuration only. EXPO_PUBLIC_* values are embedded in the app bundle:
// never put the Supabase service-role key, database URL or Expo access token here.
const projectId = process.env.EAS_PROJECT_ID

const config: ExpoConfig = {
  name: 'Apex AI',
  slug: 'apex-ai',
  scheme: 'apexai',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#07070B',
  ios: {
    bundleIdentifier: process.env.APEX_IOS_BUNDLE_ID ?? 'ai.apex.app',
    supportsTablet: true,
  },
  android: {
    package: process.env.APEX_ANDROID_PACKAGE ?? 'ai.apex.app',
    // Required for FCM v1 push on Android builds (download from Firebase; see docs).
    googleServicesFile: process.env.APEX_GOOGLE_SERVICES_JSON,
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    'expo-localization',
    ['expo-notifications', { color: '#A855F7', defaultChannel: 'default' }],
  ],
  extra: projectId ? { eas: { projectId } } : {},
}

export default config
