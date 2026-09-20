// What Reader has. One text box now, and it searches — the box that talked to
// the agent moved into the Composer, where the mic is (S3). The "syncing…" line
// that used to shove the list down became a 2px rule under the tabs (L6).
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, Animated, FlatList, Pressable, RefreshControl, StyleSheet, Text,
  TextInput, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { library, openDocument, refreshLibrary } from '../session'
import { openingTurn } from '../agent'
import { useStore } from '../store'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import type { LibraryDoc, Location } from '../types'
import { Composer } from './Composer'
import { errorText, motion, useReducedMotion } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'
import { BACK_TO_VOICE_RESERVE, useBottomInset } from './useBottomInset'

const LOCATION_LABEL: Record<Location, string> = { new: 'Inbox', later: 'Later', archive: 'Archive', feed: 'Feed' }
const TABS: Location[] = ['new', 'later', 'archive']

/** How long a failed sync shows red before the rule goes quiet again. */
const ERROR_LINGER_MS = 2000
const SKELETONS = [0, 1, 2]

function docMeta(d: LibraryDoc): string {
  const minutes = d.wordCount ? Math.max(1, Math.round(d.wordCount / 200)) : 0
  const pct = d.readingProgress ? Math.round(d.readingProgress * 100) : 0
  return [d.author, minutes ? `~${minutes} min` : null, pct ? `${pct}% read` : null].filter(Boolean).join(' · ')
}

export function LibraryScreen() {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const bottomInset = useBottomInset()
  const docs = useStore((st) => st.library)
  const location = useStore((st) => st.libraryLocation)
  const query = useStore((st) => st.libraryQuery)
  const syncing = useStore((st) => st.syncing)
  const [opening, setOpening] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)

  // The scan is cheap but it is not free, and it ran on every keystroke (L5).
  const q = useDeferredValue(query).trim()

  const shown = useMemo<LibraryDoc[]>(() => {
    if (q) {
      try {
        return library().search(q, 50)
      } catch {
        return []
      }
    }
    return docs.filter((d) => d.location === location).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }, [docs, location, q])

  const open = useCallback(async (id: string) => {
    if (opening) return
    setOpening(id)
    try {
      await openDocument(id)
      openingTurn('document')
    } catch (e) {
      useStore.getState().setNotice(errorText(e))
    } finally {
      setOpening(null)
    }
  }, [opening])

  const refresh = useCallback(async () => {
    setPulling(true)
    try {
      await refreshLibrary()
    } finally {
      setPulling(false)
    }
  }, [])

  const firstSync = docs.length === 0 && syncing

  return (
    <View style={s.screen}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Text style={s.h1}>Reader</Text>
        <Pressable role="button" accessibilityLabel="Settings" style={s.headerButton} onPress={() => useStore.getState().setScreen('settings')}>
          <Text style={s.link}>Settings</Text>
        </Pressable>
      </View>
      <View style={s.tabs}>
        {TABS.map((tab) => (
          <Pressable
            role="button"
            key={tab}
            accessibilityLabel={LOCATION_LABEL[tab]}
            accessibilityState={{ selected: tab === location && !q }}
            style={[s.tab, tab === location && !q && s.tabOn]}
            onPress={() => useStore.getState().setLibraryLocation(tab)}
          >
            <Text style={[s.tabText, tab === location && !q && s.tabTextOn]}>{LOCATION_LABEL[tab]}</Text>
          </Pressable>
        ))}
      </View>
      <SyncHairline theme={theme} />
      <TextInput
        style={s.search}
        value={query}
        onChangeText={(t) => useStore.getState().setLibraryQuery(t)}
        placeholder="Search your library"
        placeholderTextColor={theme.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        accessibilityLabel="Search your library"
      />
      {firstSync ? (
        <View style={s.skeletons}>
          {SKELETONS.map((i) => (
            <View key={i} style={s.skeletonRow}>
              <View style={s.skeletonTitle} />
              <View style={s.skeletonMeta} />
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(d) => d.id}
          keyboardShouldPersistTaps="always"
          style={{ marginBottom: bottomInset - BACK_TO_VOICE_RESERVE, overflow: 'hidden' }} // ends above the bar, clipped: see ReaderList
          contentContainerStyle={s.list}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void refresh()} tintColor={theme.accent} />}
          renderItem={({ item }) => (
            <Pressable
              role="button"
              accessibilityLabel={item.title || 'Untitled'}
              accessibilityState={{ disabled: !!opening && opening !== item.id }}
              style={s.row}
              disabled={!!opening && opening !== item.id}
              onPress={() => void open(item.id)}
            >
              <View style={s.rowText}>
                <Text style={s.rowTitle} numberOfLines={2}>{item.title || 'Untitled'}</Text>
                {q && item.location !== location ? (
                  <Text style={s.rowMeta} numberOfLines={1}>
                    {[LOCATION_LABEL[item.location], docMeta(item)].filter(Boolean).join(' · ')}
                  </Text>
                ) : (
                  !!docMeta(item) && <Text style={s.rowMeta} numberOfLines={1}>{docMeta(item)}</Text>
                )}
              </View>
              <View style={s.chevron}>
                {opening === item.id ? <ActivityIndicator color={theme.accent} /> : <Text style={s.chevronGlyph}>›</Text>}
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            q ? (
              <Text style={s.empty}>No matches for “{q}”</Text>
            ) : (
              <View style={s.emptyBlock}>
                <Text style={s.empty}>Nothing new. Save something in Reader and it lands here.</Text>
                <Pressable role="button" accessibilityLabel="Resync" style={s.headerButton} onPress={() => void refreshLibrary({ full: true })}>
                  <Text style={s.link}>Resync</Text>
                </Pressable>
              </View>
            )
          }
        />
      )}
      <Composer />
    </View>
  )
}

/**
 * The sync, as a rule rather than a sentence: brass while it runs, red for two
 * seconds if it failed, invisible the rest of the time. Nothing moves.
 */
function SyncHairline({ theme }: { theme: Theme }) {
  const s = styles(theme)
  const reduced = useReducedMotion()
  const syncing = useStore((st) => st.syncing)
  const syncError = useStore((st) => st.syncError)
  const [failing, setFailing] = useState(false)
  const width = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!syncError) return
    setFailing(true)
    const t = setTimeout(() => setFailing(false), ERROR_LINGER_MS)
    return () => clearTimeout(t)
  }, [syncError])

  useEffect(() => {
    Animated.timing(width, {
      toValue: syncing || failing ? 1 : 0,
      duration: motion(200, reduced),
      useNativeDriver: false,
    }).start()
  }, [syncing, failing, reduced, width])

  const style = {
    backgroundColor: failing ? theme.danger : theme.accent,
    opacity: width,
  }
  // testID, not a label: it is decorative to a screen reader and load-bearing to
  // the smoke test, which reads its colour to see a failed sync.
  return <Animated.View style={[s.hairline, style]} testID="sync-hairline" accessibilityElementsHidden importantForAccessibility="no" />
}

const cache = new WeakMap<Theme, ReturnType<typeof build>>()
function styles(theme: Theme) {
  let s = cache.get(theme)
  if (!s) {
    s = build(theme)
    cache.set(theme, s)
  }
  return s
}

function build(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md,
    },
    h1: { fontSize: 24, lineHeight: 30, fontWeight: '700', color: theme.textPrimary },
    headerButton: { minHeight: 44, justifyContent: 'center' },
    link: { ...type_.ui, color: theme.accent, fontWeight: '600' },
    tabs: {
      flexDirection: 'row', paddingHorizontal: space.lg, gap: space.xl,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    tab: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
    tabOn: { borderBottomColor: theme.accent },
    tabText: { ...type_.ui, color: theme.textTertiary, fontWeight: '600' },
    tabTextOn: { color: theme.textPrimary },
    hairline: { height: 2 },
    search: {
      marginHorizontal: space.lg, marginVertical: space.md,
      width: '100%', maxWidth: COLUMN_MAX_WIDTH - space.lg * 2, alignSelf: 'center',
      paddingHorizontal: space.md, height: 44,
      borderRadius: radius.input, backgroundColor: theme.surfaceSecondary,
      fontSize: 16, color: theme.textPrimary,
    },
    list: { width: '100%', maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center' },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: space.md,
      paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 56,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: '500', color: theme.textPrimary },
    rowMeta: { ...type_.meta, color: theme.textTertiary, marginTop: space.xs / 2 },
    chevron: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    chevronGlyph: { fontSize: 20, color: theme.textTertiary },
    empty: { ...type_.ui, color: theme.textTertiary, padding: space.xl },
    emptyBlock: { alignItems: 'flex-start', paddingHorizontal: space.lg },
    skeletons: { paddingHorizontal: space.lg, gap: space.md, paddingTop: space.sm },
    skeletonRow: {
      minHeight: 56, justifyContent: 'center', gap: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    skeletonTitle: { height: 14, width: '70%', borderRadius: radius.input, backgroundColor: theme.surfaceSecondary },
    skeletonMeta: { height: 10, width: '40%', borderRadius: radius.input, backgroundColor: theme.surfaceSecondary, marginBottom: space.md },
  })
}
