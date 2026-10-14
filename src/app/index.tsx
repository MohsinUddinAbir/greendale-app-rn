import { useEffect } from 'react'
import { GameWebView } from '../components/game-web-view'
import * as ScreenOrientation from 'expo-screen-orientation'

export default function App() {
  useEffect(() => {
    async function lockOrientations() {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE)
    }
    lockOrientations()
  }, [])

  return <GameWebView />
}
