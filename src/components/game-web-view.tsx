import { getTransactionDecoder, getTransactionEncoder } from '@solana/kit'
import { fromUint8Array, toUint8Array, useMobileWallet } from '@wallet-ui/react-native-kit'
import { NavigationBar } from 'expo-navigation-bar'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview'

const GAME_URL = 'https://play.greendale.games'
const GAME_BACKGROUND = '#101418'
const GAME_ZOOM = 0.75
const GAME_ZOOM_REFERENCE_WIDTH = 390
const MIN_GAME_ZOOM = 0.3
const MAX_GAME_ZOOM = 1
const PULL_START_ZONE = 48
const PULL_REFRESH_THRESHOLD = 100
const INDICATOR_MAX_DISTANCE = 64

function createViewportScript(zoom: number) {
  return `
    (() => {
      const viewportContent = [
        'width=device-width',
        'initial-scale=1',
        'minimum-scale=1',
        'maximum-scale=1',
        'user-scalable=no',
        'viewport-fit=cover'
      ].join(', ');

      const setFixedViewport = () => {
        const root = document.documentElement;
        if (!root) return;

        let viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
          viewport = document.createElement('meta');
          viewport.name = 'viewport';
          (document.head || root).appendChild(viewport);
        }
        if (viewport.content !== viewportContent) {
          viewport.content = viewportContent;
        }
        root.style.zoom = '${zoom}';
      };

      setFixedViewport();
      document.addEventListener('DOMContentLoaded', () => {
        setFixedViewport();
        if (document.head) {
          const observer = new MutationObserver(setFixedViewport);
          observer.observe(document.head, {
            attributes: true,
            attributeFilter: ['content'],
            childList: true,
            subtree: true
          });
        }
      }, { once: true });
    })();
    true;
  `
}

function createInjectedBridge(zoom: number) {
  return `
  (() => {
    window.SolanaWallet = window.SolanaWallet || {};
    window.SolanaWallet.postMessage = (message) => {
      window.ReactNativeWebView.postMessage(
        typeof message === 'string' ? message : JSON.stringify(message)
      );
    };
  })();
  true;
  ${createViewportScript(zoom)}
`
}

type WalletRequest = {
  id?: unknown
  action?: unknown
  message?: unknown
  transaction?: unknown
}

type WalletResponse = {
  id: string
  ok: boolean
  publicKey?: string
  signature?: string
  signedTransaction?: string
  error?: string
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function requireBase64Field(value: unknown, fieldName: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing Base64-encoded ${fieldName}.`)
  }

  try {
    return toUint8Array(value)
  } catch {
    throw new Error(`Invalid Base64-encoded ${fieldName}.`)
  }
}

export function GameWebView() {
  const webView = useRef<WebView | null>(null)
  const walletRequestInProgress = useRef(false)
  const { width } = useWindowDimensions()
  const { account, connect, disconnect, signMessages, signTransactions } = useMobileWallet()
  const gameZoom = Math.min(MAX_GAME_ZOOM, Math.max(MIN_GAME_ZOOM, (GAME_ZOOM * width) / GAME_ZOOM_REFERENCE_WIDTH))
  const [canGoBack, setCanGoBack] = useState(false)
  const [isPageLoaded, setIsPageLoaded] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [pageError, setPageError] = useState<string | null>(null)

  function sendWalletResponse(response: WalletResponse) {
    const responseJson = JSON.stringify(response)
    const serializedResponse = JSON.stringify(responseJson)
    webView.current?.injectJavaScript(`
      (() => {
        const response = JSON.parse(${serializedResponse});
        window.dispatchEvent(new CustomEvent('solana-wallet-response', { detail: response }));
      })();
      true;
    `)
  }

  async function handleWalletMessage(event: WebViewMessageEvent) {
    let request: WalletRequest
    try {
      const decoded: unknown = JSON.parse(event.nativeEvent.data)
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Expected a JSON object.')
      }
      request = decoded as WalletRequest
    } catch (error) {
      console.error('Invalid wallet bridge request:', getErrorMessage(error))
      return
    }

    const requestId = request.id == null ? '' : String(request.id)
    const action = request.action == null ? '' : String(request.action)
    if (!requestId) {
      console.error('Wallet bridge request has no ID.')
      return
    }

    if (walletRequestInProgress.current) {
      sendWalletResponse({
        id: requestId,
        ok: false,
        error: 'Another wallet request is already in progress.',
      })
      return
    }

    walletRequestInProgress.current = true
    try {
      if (Platform.OS !== 'android') {
        throw new Error('Solana Mobile Wallet Adapter is currently supported only on Android.')
      }

      switch (action) {
        case 'connect': {
          const authorizedAccount = await connect()
          sendWalletResponse({ id: requestId, ok: true, publicKey: authorizedAccount.address.toString() })
          break
        }
        case 'disconnect':
          await disconnect()
          sendWalletResponse({ id: requestId, ok: true })
          break
        case 'signMessage': {
          if (!account) throw new Error('Connect your wallet first.')
          const message = requireBase64Field(request.message, 'message')
          const signedPayload = await signMessages(message)
          sendWalletResponse({ id: requestId, ok: true, signature: fromUint8Array(signedPayload) })
          break
        }
        case 'signTransaction': {
          if (!account) throw new Error('Connect your wallet first.')
          const transactionBytes = requireBase64Field(request.transaction, 'transaction')
          const transaction = getTransactionDecoder().decode(transactionBytes)
          const signedTransaction = await signTransactions(transaction)
          const encodedTransaction = getTransactionEncoder().encode(signedTransaction)
          sendWalletResponse({
            id: requestId,
            ok: true,
            signedTransaction: fromUint8Array(Uint8Array.from(encodedTransaction)),
          })
          break
        }
        default:
          throw new Error(`Unsupported wallet action: ${action}`)
      }
    } catch (error) {
      console.error(`Wallet action "${action}" failed:`, error)
      const message = getErrorMessage(error)
      console.error(`Wallet action "${action}" failed:`, message)
      sendWalletResponse({ id: requestId, ok: false, error: message })
    } finally {
      walletRequestInProgress.current = false
    }
  }

  const refreshWebView = useCallback(() => {
    if (!isPageLoaded || isRefreshing) return
    setPullDistance(0)
    setIsRefreshing(true)
    webView.current?.reload()
  }, [isPageLoaded, isRefreshing])

  const pullResponder = useMemo(
    () =>
      // PanResponder invokes these callbacks in response to gestures, not during render.
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          isPageLoaded &&
          !isRefreshing &&
          gesture.y0 <= PULL_START_ZONE &&
          gesture.dy > 8 &&
          gesture.dy > Math.abs(gesture.dx) * 1.2,
        onPanResponderMove: (_event, gesture) => {
          setPullDistance(Math.min(gesture.dy * 0.55, INDICATOR_MAX_DISTANCE))
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy >= PULL_REFRESH_THRESHOLD && gesture.dy > Math.abs(gesture.dx) * 1.2) {
            refreshWebView()
          } else {
            setPullDistance(0)
          }
        },
        onPanResponderTerminate: () => setPullDistance(0),
      }),
    [isPageLoaded, isRefreshing, refreshWebView],
  )

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack) {
        webView.current?.goBack()
        return true
      }

      Alert.alert('Exit Greendale?', 'Are you sure you want to close the game?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Exit', style: 'destructive', onPress: () => BackHandler.exitApp() },
      ])
      return true
    })

    return () => subscription.remove()
  }, [canGoBack])

  useEffect(() => {
    if (isPageLoaded) {
      webView.current?.injectJavaScript(createViewportScript(gameZoom))
    }
  }, [gameZoom, isPageLoaded])

  function handleNavigationChange(navigation: WebViewNavigation) {
    setCanGoBack(navigation.canGoBack)
  }

  const isPulling = pullDistance > 0

  return (
    <View style={styles.container} {...pullResponder.panHandlers}>
      <WebView
        ref={webView}
        source={{ uri: GAME_URL }}
        style={styles.webView}
        containerStyle={styles.webView}
        javaScriptEnabled
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={createInjectedBridge(gameZoom)}
        onMessage={(event) => void handleWalletMessage(event)}
        onNavigationStateChange={handleNavigationChange}
        pullToRefreshEnabled={false}
        onLoadStart={() => {
          setIsPageLoaded(false)
          setPageError(null)
        }}
        onLoadEnd={() => {
          setIsPageLoaded(true)
          setIsRefreshing(false)
        }}
        onError={(event) => {
          const description = event.nativeEvent.description || 'Unable to load Greendale.'
          console.error('Greendale WebView error:', description)
          setPageError(description)
          setIsRefreshing(false)
        }}
        onHttpError={(event) => {
          console.error(`Greendale HTTP error ${event.nativeEvent.statusCode}: ${event.nativeEvent.description}`)
        }}
      />

      {(isPulling || isRefreshing) && (
        <View
          pointerEvents="none"
          style={[
            styles.refreshIndicator,
            { opacity: isPulling || isRefreshing ? 1 : 0, transform: [{ translateY: 8 + pullDistance * 0.65 }] },
          ]}
        >
          <View style={styles.refreshDot}>
            {isRefreshing ? <ActivityIndicator color="#46D7A4" size="small" /> : <Text style={styles.arrow}>↓</Text>}
          </View>
          <Text style={styles.refreshText}>
            {isRefreshing
              ? 'Reloading Greendale...'
              : pullDistance >= INDICATOR_MAX_DISTANCE
                ? 'Release to reload'
                : 'Pull down to reload'}
          </Text>
        </View>
      )}

      {pageError && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorTitle}>Greendale could not load</Text>
          <Text style={styles.errorMessage}>{pageError}</Text>
          <Pressable onPress={() => webView.current?.reload()} style={styles.retryButton}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      <StatusBar hidden />
      <NavigationBar hidden />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: GAME_BACKGROUND,
    flex: 1,
  },
  webView: {
    backgroundColor: GAME_BACKGROUND,
    flex: 1,
  },
  refreshIndicator: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(32, 40, 45, 0.96)',
    borderColor: 'rgba(70, 215, 164, 0.45)',
    borderRadius: 28,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 40,
    paddingHorizontal: 18,
    position: 'absolute',
    top: 8,
    zIndex: 2,
  },
  refreshDot: {
    width: 20,
    height: 20,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrow: {
    color: '#46D7A4',
    fontSize: 20,
    fontWeight: '700',
    marginTop: -5,
  },
  refreshText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  errorOverlay: {
    alignItems: 'center',
    backgroundColor: GAME_BACKGROUND,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    padding: 24,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  errorTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  errorMessage: {
    color: '#B9C3C8',
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#46D7A4',
    borderRadius: 12,
    marginTop: 20,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  retryText: {
    color: '#101418',
    fontSize: 15,
    fontWeight: '700',
  },
})
