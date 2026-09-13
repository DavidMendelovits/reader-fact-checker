// Four screens, one file: token gate → Reader library → the reader itself, with
// settings off to the side. The reader is deliberately sparse — the conversation
// is the interface; the screen shows where the voice is in the text and paints
// the highlights in place.
import { StatusBar } from 'expo-status-bar'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, SafeAreaView, StyleSheet,
  Text, TextInput, View,
} from 'react-native'
import { useStore, type AgentState } from './src/store'
import { apiBase, clearToken, loadSettings, saveApiBase, saveToken } from './src/settings'
import { activeVoice, enableKokoro, useVoice } from './src/providers'
import { kokoroSizeMb } from './src/kokoro'
import {
  closeDocument, highlightParagraph, library, moveDocument, openDocument, refreshLibrary,
  removeHighlight, setHighlightNote, startLibrary, stopLibrary,
} from './src/session'
import { openingTurn, pause, play, resetConversation, setMicEnabled } from './src/agent'
import { splitRuns } from './src/highlights'
import type { FlatParagraph, Highlight, LibraryDoc, Location } from './src/types'

const AGENT_LABEL: Record<AgentState, string> = {
  idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', reading: 'Reading',
}

const LOCATION_LABEL: Record<Location, string> = { new: 'Inbox', later: 'Later', archive: 'Archive', feed: 'Feed' }
const TABS: Location[] = ['new', 'later', 'archive']

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function App() {
  const [token, setToken] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)
  const screen = useStore((s) => s.screen)

  useEffect(() => {
    void loadSettings().then(async ({ token, voice }) => {
      await useVoice(voice) // loads the on-device model now rather than on the first paragraph
      if (token) {
        try {
          await startLibrary(token)
        } catch (e) {
          useStore.getState().setNotice(`Couldn't open your library: ${errorText(e)}`)
        }
      }
      setToken(token)
      setBooted(true)
      // Voice-first: the ear is on from the moment the library shows. The header
      // toggle is for turning it off, not for finding it.
      if (token) setMicEnabled(true)
    })
  }, [])

  if (!booted) return <Centered><ActivityIndicator /></Centered>
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {!token ? (
        <TokenScreen onSaved={setToken} />
      ) : screen === 'reader' ? (
        <ReaderScreen />
      ) : screen === 'settings' ? (
        <SettingsScreen onSignOut={() => setToken(null)} />
      ) : (
        <LibraryScreen />
      )}
      <Notice />
    </SafeAreaView>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={[styles.root, styles.centered]}>{children}</View>
}

function Notice() {
  const notice = useStore((s) => s.notice)
  if (!notice) return null
  return (
    <Pressable style={styles.notice} onPress={() => useStore.getState().setNotice(null)}>
      <Text style={styles.noticeText}>{notice}</Text>
    </Pressable>
  )
}

/** The one mic control, shared by the library header and the reader footer. */
function MicToggle() {
  const micEnabled = useStore((s) => s.micEnabled)
  return (
    <Pressable onPress={() => setMicEnabled(!micEnabled)} hitSlop={8}>
      <Text style={[styles.mic, micEnabled && styles.micOn]}>{micEnabled ? '● mic on' : '○ mic off'}</Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------- sign-in

function TokenScreen({ onSaved }: { onSaved: (t: string) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    try {
      await saveToken(token)
      await startLibrary(token)
      onSaved(token)
      setMicEnabled(true) // voice-first from the first screen
    } catch (e) {
      useStore.getState().setNotice(`Couldn't open your library: ${errorText(e)}`)
      setBusy(false)
    }
  }

  return (
    <View style={styles.tokenScreen}>
      <Text style={styles.h1}>Reader, out loud</Text>
      <Text style={styles.body}>
        Paste your Readwise access token (readwise.io/access_token). It stays on this device.
      </Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="Access token"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
      />
      <Pressable
        style={[styles.button, (!value.trim() || busy) && styles.buttonDisabled]}
        disabled={!value.trim() || busy}
        onPress={() => void save()}
      >
        {busy ? <ActivityIndicator color="#faf8f4" /> : <Text style={styles.buttonText}>Open my library</Text>}
      </Pressable>
    </View>
  )
}

// ---------------------------------------------------------------- library

function docMeta(d: LibraryDoc): string {
  const minutes = d.wordCount ? Math.max(1, Math.round(d.wordCount / 200)) : 0
  const pct = d.readingProgress ? Math.round(d.readingProgress * 100) : 0
  return [d.author, minutes ? `~${minutes} min` : null, pct ? `${pct}% read` : null].filter(Boolean).join(' · ')
}

function LibraryScreen() {
  const docs = useStore((s) => s.library)
  const location = useStore((s) => s.libraryLocation)
  const query = useStore((s) => s.libraryQuery)
  const syncing = useStore((s) => s.syncing)
  const [opening, setOpening] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)

  // Voice-first: arriving at the library with the mic on lets the agent say hello.
  useEffect(() => {
    if (useStore.getState().micEnabled) openingTurn('library')
  }, [])

  const q = query.trim()
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

  const open = async (id: string) => {
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
  }

  const refresh = async () => {
    setPulling(true)
    try {
      await refreshLibrary()
    } finally {
      setPulling(false)
    }
  }

  const empty =
    docs.length === 0 && syncing ? (
      <View style={[styles.centered, styles.padded]}><ActivityIndicator /></View>
    ) : q ? (
      <Text style={[styles.body, styles.padded]}>No matches.</Text>
    ) : docs.length === 0 ? (
      <Text style={[styles.body, styles.padded]}>
        Your Reader library hasn't arrived yet. Pull down to sync — anything you save to Reader shows up here.
      </Text>
    ) : (
      <Text style={[styles.body, styles.padded]}>Nothing here.</Text>
    )

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Text style={styles.h1}>Reader</Text>
        <MicToggle />
        <Pressable onPress={() => useStore.getState().setScreen('settings')} hitSlop={8}>
          <Text style={styles.link}>settings</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {TABS.map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tab, tab === location && !q && styles.tabActive]}
            onPress={() => useStore.getState().setLibraryLocation(tab)}
          >
            <Text style={[styles.tabText, tab === location && !q && styles.tabTextActive]}>{LOCATION_LABEL[tab]}</Text>
          </Pressable>
        ))}
      </View>
      {syncing && <Text style={styles.syncLine}>syncing…</Text>}
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={(t) => useStore.getState().setLibraryQuery(t)}
        placeholder="Search your library"
        placeholderTextColor="#a9a297"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
      />
      <FlatList
        data={shown}
        keyExtractor={(d) => d.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void refresh()} tintColor="#8a5a2b" />}
        renderItem={({ item }) => (
          <Pressable style={styles.docRow} onPress={() => void open(item.id)}>
            <View style={styles.flex}>
              <Text style={styles.docTitle} numberOfLines={2}>{item.title || 'Untitled'}</Text>
              {q && item.location !== location ? (
                <Text style={styles.docMeta} numberOfLines={1}>
                  {[LOCATION_LABEL[item.location], docMeta(item)].filter(Boolean).join(' · ')}
                </Text>
              ) : (
                !!docMeta(item) && <Text style={styles.docMeta} numberOfLines={1}>{docMeta(item)}</Text>
              )}
            </View>
            {opening === item.id && <ActivityIndicator />}
          </Pressable>
        )}
        ListEmptyComponent={empty}
      />
    </View>
  )
}

// ---------------------------------------------------------------- reader

/** A highlight's span in one paragraph, in the shape splitRuns wants. */
interface Mark {
  start: number
  end: number
  h: Highlight
}

interface ParagraphRowProps {
  item: FlatParagraph
  index: number
  current: boolean
  marks: Mark[]
  onLongPress: (index: number) => void
  onPressMark: (h: Highlight) => void
}

const ParagraphRow = memo(function ParagraphRow({ item, index, current, marks, onLongPress, onPressMark }: ParagraphRowProps) {
  const runs = splitRuns(item.text, marks)
  const heading = item.paragraphIndex === 0
  return (
    <Text
      style={[styles.paragraph, heading && styles.chapterHeading, current && styles.currentParagraph]}
      onLongPress={() => onLongPress(index)}
    >
      {runs.map((r, i) =>
        r.mark ? (
          <Text
            key={i}
            style={[styles.mark, r.mark.h.pending === 'create' && styles.markPending]}
            onPress={() => onPressMark(r.mark!.h)}
          >
            {r.text}
            {r.mark.h.note ? <Text style={styles.markNote}> ✎</Text> : null}
          </Text>
        ) : (
          <Text key={i}>{r.text}</Text>
        ),
      )}
    </Text>
  )
})

function ReaderScreen() {
  const doc = useStore((s) => s.doc)
  const libraryDoc = useStore((s) => s.libraryDoc)
  const paragraphs = useStore((s) => s.paragraphs)
  const current = useStore((s) => s.currentParagraph)
  const playing = useStore((s) => s.playing)
  const rate = useStore((s) => s.rate)
  const agentState = useStore((s) => s.agentState)
  const chat = useStore((s) => s.chat)
  const highlights = useStore((s) => s.highlights)
  const list = useRef<FlatList<FlatParagraph>>(null)
  const mounted = useRef(false)
  const [noteTarget, setNoteTarget] = useState<Highlight | null>(null)

  // Follow the voice. The first scroll waits for the list to lay out, since the
  // position is restored from last time and may be deep in the text.
  useEffect(() => {
    if (paragraphs.length === 0) return
    const go = () => list.current?.scrollToIndex({ index: current, viewPosition: 0.3, animated: true })
    if (mounted.current) {
      go()
      return
    }
    mounted.current = true
    const t = setTimeout(go, 350)
    return () => clearTimeout(t)
  }, [current, paragraphs.length])

  // Highlights that were found in the text, grouped by paragraph, for painting.
  const painted = useMemo(() => highlights.filter((h) => h.anchor && h.pending !== 'delete'), [highlights])
  const marksByParagraph = useMemo(() => {
    const m = new Map<number, Mark[]>()
    for (const h of painted) {
      const a = h.anchor!
      const arr = m.get(a.paragraph) ?? []
      arr.push({ start: a.start, end: a.end, h })
      m.set(a.paragraph, arr)
    }
    return m
  }, [painted])

  const jumpToNextHighlight = () => {
    if (painted.length === 0) return
    const at = [...new Set(painted.map((h) => h.anchor!.paragraph))].sort((a, b) => a - b)
    const next = at.find((i) => i > current) ?? at[0]
    list.current?.scrollToIndex({ index: next, viewPosition: 0.3, animated: true })
  }

  const askHighlight = (index: number) => {
    const p = useStore.getState().paragraphs[index]
    if (!p) return
    Alert.alert('Highlight this paragraph?', p.text.slice(0, 120) + (p.text.length > 120 ? '…' : ''), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Highlight',
        onPress: () => void highlightParagraph(index).catch((e: unknown) => useStore.getState().setNotice(errorText(e))),
      },
    ])
  }

  const askMark = (h: Highlight) => {
    Alert.alert(h.note ? h.note : 'Highlight', h.text.slice(0, 120), [
      { text: h.note ? 'Edit note' : 'Add note', onPress: () => setNoteTarget(h) },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void removeHighlight(h.id).catch((e: unknown) => useStore.getState().setNotice(errorText(e))),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const askMove = () => {
    if (!libraryDoc) return
    const id = libraryDoc.id
    const move = (to: Location) => () =>
      void moveDocument(id, to).catch((e: unknown) => useStore.getState().setNotice(errorText(e)))
    Alert.alert('File under', `Now in ${LOCATION_LABEL[libraryDoc.location]}.`, [
      ...TABS.filter((t) => t !== libraryDoc.location).map((t) => ({ text: LOCATION_LABEL[t], onPress: move(t) })),
      { text: 'Cancel', style: 'cancel' as const },
    ])
  }

  const lastLine = chat[chat.length - 1]
  const count = painted.length

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Pressable onPress={() => void closeDocument()} hitSlop={8}>
          <Text style={styles.link}>‹ Library</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{doc?.title}</Text>
        <Pressable onPress={askMove} hitSlop={8} disabled={!libraryDoc}>
          <Text style={styles.filing}>{libraryDoc ? LOCATION_LABEL[libraryDoc.location] : ''} ▾</Text>
        </Pressable>
      </View>
      <FlatList
        ref={list}
        data={paragraphs}
        keyExtractor={(_, i) => String(i)}
        onScrollToIndexFailed={(info) => {
          // Not laid out that far yet: get close, then try again once it is.
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: true }), 250)
        }}
        renderItem={({ item, index }) => (
          <ParagraphRow
            item={item}
            index={index}
            current={index === current}
            marks={marksByParagraph.get(index) ?? []}
            onLongPress={askHighlight}
            onPressMark={askMark}
          />
        )}
        contentContainerStyle={styles.readerContent}
      />
      <View style={styles.footer}>
        {lastLine && (
          <Text style={styles.chatLine} numberOfLines={2}>
            {lastLine.role === 'user' ? 'You: ' : ''}{lastLine.text}
          </Text>
        )}
        <View style={styles.footerRow}>
          <MicToggle />
          <Text style={styles.agentState}>{AGENT_LABEL[agentState]}</Text>
          <Pressable onPress={() => (playing ? pause() : play())} hitSlop={8}>
            <Text style={styles.link}>{playing ? '❚❚ Pause' : '▶ Play'}</Text>
          </Pressable>
        </View>
        <View style={styles.footerRow}>
          <Pressable onPress={jumpToNextHighlight} disabled={count === 0} hitSlop={8}>
            <Text style={[styles.docMeta, count > 0 && styles.highlightCount]}>
              {count === 1 ? '1 highlight' : `${count} highlights`}
            </Text>
          </Pressable>
          <Text style={styles.docMeta}>{rate}x · ¶{current + 1}/{paragraphs.length}</Text>
        </View>
      </View>
      {noteTarget && <NoteModal highlight={noteTarget} onClose={() => setNoteTarget(null)} />}
    </View>
  )
}

/** Add or edit the note on a highlight. A Modal rather than Alert.prompt, which is iOS-only. */
function NoteModal({ highlight, onClose }: { highlight: Highlight; onClose: () => void }) {
  const [text, setText] = useState(highlight.note ?? '')
  const save = () => {
    void setHighlightNote(highlight.id, text).catch((e: unknown) => useStore.getState().setNotice(errorText(e)))
    onClose()
  }
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>{highlight.note ? 'Edit note' : 'Add a note'}</Text>
          <Text style={styles.modalQuote} numberOfLines={3}>“{highlight.text}”</Text>
          <TextInput
            style={[styles.input, styles.noteInput]}
            value={text}
            onChangeText={setText}
            placeholder="Your note"
            placeholderTextColor="#a9a297"
            multiline
            autoFocus
          />
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} hitSlop={8}><Text style={styles.link}>Cancel</Text></Pressable>
            <Pressable style={styles.button} onPress={save}><Text style={styles.buttonText}>Save</Text></Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ---------------------------------------------------------------- settings

/**
 * System voice or on-device Kokoro. The first tap on "on-device" downloads the
 * model (~90MB) with progress; after that it's a toggle.
 */
function VoicePicker() {
  const [voice, setVoice] = useState(activeVoice())
  const [busy, setBusy] = useState<string | null>(null)
  const [sizeMb, setSizeMb] = useState<number | null>(null)

  useEffect(() => {
    void kokoroSizeMb().then(setSizeMb)
  }, [])

  const toggle = async () => {
    if (busy) return
    if (voice === 'kokoro') {
      setVoice(await useVoice('system'))
      return
    }
    setBusy('preparing…')
    try {
      await enableKokoro((p) => {
        const pct = Math.round(p.percent)
        setBusy(p.phase === 'downloading' ? `downloading ${pct}%` : `unpacking ${pct}%`)
      })
      setVoice('kokoro')
    } catch (e) {
      useStore.getState().setNotice(`On-device voice unavailable: ${errorText(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const label = busy
    ? busy
    : voice === 'kokoro'
      ? 'voice: on-device'
      : `voice: system${sizeMb ? ` · get on-device (${sizeMb}MB)` : ''}`
  return (
    <Pressable onPress={() => void toggle()} disabled={!!busy}>
      <Text style={[styles.link, busy && styles.buttonDisabled]}>{label}</Text>
    </Pressable>
  )
}

function SettingsScreen({ onSignOut }: { onSignOut: () => void }) {
  const syncing = useStore((s) => s.syncing)
  const lastSync = useStore((s) => s.lastSync)
  const [base, setBase] = useState(apiBase)
  const [signingOut, setSigningOut] = useState(false)

  const saveBase = async () => {
    await saveApiBase(base)
    setBase(apiBase) // the normalized value (trailing slash dropped, default restored if blank)
  }

  const signOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      resetConversation()
      setMicEnabled(false)
      stopLibrary()
      await clearToken()
      const st = useStore.getState()
      st.setLibraryQuery('')
      st.setScreen('library') // where the next sign-in lands
      onSignOut()
    } catch (e) {
      useStore.getState().setNotice(errorText(e))
      setSigningOut(false)
    }
  }

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Pressable onPress={() => useStore.getState().setScreen('library')} hitSlop={8}>
          <Text style={styles.link}>‹ Library</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.settingsBody}>
        <View style={styles.settingsRow}>
          <Text style={styles.settingsLabel}>Voice</Text>
          <VoicePicker />
        </View>
        <View style={styles.settingsBlock}>
          <Text style={styles.settingsLabel}>API base URL</Text>
          <TextInput
            style={styles.input}
            value={base}
            onChangeText={setBase}
            onBlur={() => void saveBase()}
            placeholder={apiBase}
            placeholderTextColor="#a9a297"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.settingsHint}>The deployed web app whose /api routes the phone talks to. Saved when you leave the field.</Text>
        </View>
        <View style={styles.settingsRow}>
          <View style={styles.flex}>
            <Text style={styles.settingsLabel}>Library</Text>
            <Text style={styles.settingsHint}>
              {syncing ? 'syncing…' : lastSync ? `last synced ${new Date(lastSync).toLocaleString()}` : 'not synced yet'}
            </Text>
          </View>
          <Pressable onPress={() => void refreshLibrary({ full: true })} disabled={syncing} hitSlop={8}>
            <Text style={[styles.link, syncing && styles.buttonDisabled]}>Resync library</Text>
          </Pressable>
        </View>
        <Pressable
          style={[styles.button, styles.signOut, signingOut && styles.buttonDisabled]}
          onPress={() => void signOut()}
          disabled={signingOut}
        >
          <Text style={styles.buttonText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------- styles

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#faf8f4' },
  flex: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: 20 },
  h1: { fontSize: 24, fontWeight: '700', color: '#1a1712' },
  body: { fontSize: 15, color: '#5a544a', lineHeight: 22 },
  link: { fontSize: 15, color: '#8a5a2b', fontWeight: '600' },
  tokenScreen: { padding: 24, gap: 14, justifyContent: 'center', flex: 1 },
  input: {
    borderWidth: 1, borderColor: '#d8d2c6', borderRadius: 8, padding: 12,
    fontSize: 15, backgroundColor: '#fff', color: '#1a1712',
  },
  button: { backgroundColor: '#1a1712', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#faf8f4', fontSize: 15, fontWeight: '600' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    borderBottomWidth: 1, borderBottomColor: '#e8e2d6',
  },
  headerTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#1a1712', textAlign: 'center' },
  headerSpacer: { width: 64 },
  filing: { fontSize: 13, color: '#8a5a2b', fontWeight: '600' },

  // library
  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 18, borderBottomWidth: 1, borderBottomColor: '#e8e2d6' },
  tab: { paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
  tabActive: { borderBottomColor: '#8a5a2b' },
  tabText: { fontSize: 15, color: '#8d867a', fontWeight: '600' },
  tabTextActive: { color: '#1a1712' },
  syncLine: { fontSize: 12, color: '#8a5a2b', paddingHorizontal: 16, paddingTop: 6 },
  search: {
    marginHorizontal: 16, marginVertical: 10, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 8, backgroundColor: '#f1ece3', fontSize: 15, color: '#1a1712',
  },
  docRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#efe9df',
  },
  docTitle: { fontSize: 16, color: '#1a1712', fontWeight: '500' },
  docMeta: { fontSize: 13, color: '#8d867a', marginTop: 2 },

  // reader
  readerContent: { paddingBottom: 24 },
  paragraph: { fontSize: 17, lineHeight: 27, color: '#3c372e', paddingHorizontal: 20, paddingVertical: 8 },
  chapterHeading: { fontSize: 22, lineHeight: 30, fontWeight: '700', color: '#1a1712', paddingTop: 28, paddingBottom: 10 },
  currentParagraph: { backgroundColor: '#f3ead8', color: '#1a1712' },
  mark: { backgroundColor: '#f6e7a8', color: '#1a1712' },
  markPending: { backgroundColor: '#f9efc6' },
  markNote: { color: '#8a5a2b', fontSize: 13 },
  footer: { borderTopWidth: 1, borderTopColor: '#e8e2d6', padding: 12, gap: 8, backgroundColor: '#faf8f4' },
  chatLine: { fontSize: 14, color: '#5a544a', fontStyle: 'italic' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mic: { fontSize: 14, color: '#8d867a', fontWeight: '600' },
  micOn: { color: '#2b6a3f' },
  agentState: { fontSize: 13, color: '#8a5a2b' },
  highlightCount: { color: '#8a5a2b', fontWeight: '600' },

  // note modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(26,23,18,0.45)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#faf8f4', borderRadius: 12, padding: 20, gap: 12 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1a1712' },
  modalQuote: { fontSize: 14, color: '#5a544a', fontStyle: 'italic', lineHeight: 20 },
  noteInput: { minHeight: 80, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 20 },

  // settings
  settingsBody: { padding: 20, gap: 28 },
  settingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  settingsBlock: { gap: 8 },
  settingsLabel: { fontSize: 15, fontWeight: '600', color: '#1a1712' },
  settingsHint: { fontSize: 13, color: '#8d867a', lineHeight: 18 },
  signOut: { backgroundColor: '#8a3b2b', marginTop: 8 },

  notice: {
    position: 'absolute', bottom: 90, left: 16, right: 16, backgroundColor: '#1a1712',
    borderRadius: 10, padding: 12,
  },
  noticeText: { color: '#faf8f4', fontSize: 14 },
})
