import '../global.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Slot } from 'expo-router'
import { AppIdentity, createSolanaDevnet, MobileWalletProvider } from '@wallet-ui/react-native-kit'

const cluster = createSolanaDevnet()
const identity: AppIdentity = {
  name: 'Greendale',
  uri: 'https://play.greendale.games',
  icon: 'logo.png',
}
const queryClient = new QueryClient()

export default function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <MobileWalletProvider cluster={cluster} identity={identity}>
        <Slot />
      </MobileWalletProvider>
    </QueryClientProvider>
  )
}
